import {
  abilityAccessCtrl,
  common,
  PermissionRequestResult,
  Permissions
} from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import {
  SettingsDetailPage,
  SettingsDetailPageKind
} from '../components/SettingsDetailPage';
import { SettingsPage } from '../components/SettingsPage';
import {
  APP_HOME_URL,
  classifyNavigationUrl,
  isOauthCandidateUrl,
  isPrimaryAppOrigin,
  isSafeDownloadUrl,
  isSafeExternalUrl,
  NavigationDecision,
  safeHttpsHostname
} from '../common/NavigationPolicy';
import {
  buildShellActivationScript,
  buildShellRollbackScript,
  buildTopLayerDismissScript,
  buildWebActionScript,
  isShellUnsupportedResult,
  NativeWebAction,
  SHELL_LIFECYCLE_BRIDGE_METHOD,
  SHELL_LIFECYCLE_BRIDGE_NAME,
  shouldAcceptShellActivation,
  shouldExposeNativeHeaderControls,
  shouldAcceptTopLayerDismiss,
  shouldAcceptWebAction
} from '../common/NativeShellPolicy';
import {
  ShellEvaluationClock,
  ShellEvaluationDecision,
  ShellEvaluationRequest,
  ShellRollbackDecision
} from '../common/ShellEvaluationClock';
import {
  AURORA_ABOUT_ROUTE,
  AURORA_PRIVACY_ROUTE,
  AURORA_SETTINGS_ROUTE,
  AURORA_WEB_ROUTE,
  decideWebBack,
  hasRoute,
  PendingWebAction,
  shouldAttemptTopLayerDismiss,
  shouldCreateFreshWebController,
  shouldOpenInitialConversation,
  shouldPushRoute,
  shouldTerminateAfterBackgroundFailure,
  WebBackAction
} from '../common/WorkspaceNavigationPolicy';
import { isCurrentDownloadCallback } from '../common/DownloadLifecyclePolicy';
import {
  isWorkspaceUiFixtureBootstrapUrl,
  loadWorkspaceUiFixture,
  shouldAllowWorkspaceUiFixtureLoadUrl,
  WORKSPACE_INITIAL_URL,
  workspaceUiControllerDescription
} from '../common/WorkspaceUiFixture';
import { NetworkMonitor } from '../services/NetworkMonitor';
import { HapticFeedbackService } from '../services/HapticFeedbackService';
import {
  SHELL_LIFECYCLE_PERMISSION,
  ShellLifecycleBridge
} from '../services/ShellLifecycleBridge';
import { SystemShareService } from '../services/SystemShareService';

const MICROPHONE_PERMISSION: Permissions = 'ohos.permission.MICROPHONE';
const MAX_SELECTABLE_FILES: number = 8;

class DownloadTarget {
  cachePath: string;
  fileName: string;
  item: webview.WebDownloadItem;
  webInstanceEpoch: number;

  constructor(
    cachePath: string,
    fileName: string,
    item: webview.WebDownloadItem,
    webInstanceEpoch: number
  ) {
    this.cachePath = cachePath;
    this.fileName = fileName;
    this.item = item;
    this.webInstanceEpoch = webInstanceEpoch;
  }
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private pathStack: NavPathStack = new NavPathStack();
  private workspaceUiFixtureLoaded: boolean = false;
  private downloadDelegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  private downloadDelegateConfigured: boolean = false;
  private downloadTargets: Map<string, DownloadTarget> = new Map<string, DownloadTarget>();
  private webInstanceEpoch: number = 0;
  private webControllerEpoch: number = 0;
  private navigationGeneration: number = 0;
  private shellEvaluationClock: ShellEvaluationClock = new ShellEvaluationClock();
  private shellLifecycleBridge: ShellLifecycleBridge =
    new ShellLifecycleBridge(this.controller);
  private shellLifecycleActive: boolean = false;
  private shellLifecycleReconciledActive: boolean = false;
  private shellLifecycleEpoch: number = 0;
  private shellEvaluationTimerId: number = -1;
  private webControllerAttached: boolean = false;
  private webDestinationActive: boolean = false;
  private webDestinationVisible: boolean = false;
  private webInstanceNeedsReset: boolean = true;
  private pendingWebAction: PendingWebAction = PendingWebAction.NONE;
  private webBackRequestPending: boolean = false;
  private appBackgroundRequestPending: boolean = false;
  private downloadCacheCleared: boolean = false;
  private networkMonitor: NetworkMonitor | undefined = undefined;

  @State private loading: boolean = false;
  @State private progress: number = 0;
  @State private loadFailed: boolean = false;
  @State private hasLoadedOnce: boolean = false;
  @State private nativeShellReady: boolean = false;
  @State private nativeHeaderControlsVisible: boolean = false;
  @State private online: boolean = true;
  @State private oauthNavigationActive: boolean = false;
  @State private externalAuthHost: string = '';
  @State private pendingOauthUrl: string = '';
  @State private pendingOauthHost: string = '';

  aboutToAppear(): void {
    if (this.networkMonitor === undefined) {
      this.networkMonitor = new NetworkMonitor((online: boolean) => {
        this.online = online;
      });
    }
    this.networkMonitor.start();
    if (!this.downloadCacheCleared) {
      this.clearStaleDownloadCache();
      this.downloadCacheCleared = true;
    }
  }

  aboutToDisappear(): void {
    this.webDestinationActive = false;
    this.webDestinationVisible = false;
    this.reconcileWebLifecycle();
    this.invalidateActiveDownloads();
    try {
      // Deletion applies on the next reload, so the inactive epoch above is
      // the immediate guard for any late call from the current document.
      this.controller.deleteJavaScriptRegister(SHELL_LIFECYCLE_BRIDGE_NAME);
    } catch (_) {
      // ArkWeb may already be detached while the component is disappearing.
    }
    if (this.networkMonitor !== undefined) {
      this.networkMonitor.stop();
    }
  }

  private reconcileWebLifecycle(): void {
    const shouldBeActive: boolean = this.webDestinationVisible &&
      this.webDestinationActive &&
      this.webControllerAttached;
    if (!shouldBeActive) {
      this.webBackRequestPending = false;
      if (!this.shellLifecycleReconciledActive) {
        return;
      }

      this.shellLifecycleReconciledActive = false;
      this.shellLifecycleActive = false;
      this.shellLifecycleEpoch += 1;
      this.shellLifecycleBridge.detach();
      this.clearDeferredShellEvaluation();
      this.shellEvaluationClock.invalidate();
      this.nativeShellReady = false;
      this.nativeHeaderControlsVisible = false;
      try {
        this.controller.onInactive();
      } catch (_) {
        // ArkWeb may already be detached while the destination is changing.
      }
      return;
    }

    if (!this.shellLifecycleReconciledActive) {
      this.shellLifecycleReconciledActive = true;
      this.shellLifecycleActive = true;
      this.shellLifecycleEpoch += 1;
      this.shellEvaluationClock.beginGeneration(this.navigationGeneration);
      this.shellLifecycleBridge.attach((generation: number) => {
        this.handleShellLifecycleSignal(generation);
      });
      try {
        this.controller.onActive();
      } catch (_) {
        // ArkWeb can attach between lifecycle frames; the next reconcile retries.
        this.shellLifecycleReconciledActive = false;
        this.shellLifecycleActive = false;
        this.shellLifecycleBridge.detach();
        this.shellEvaluationClock.invalidate();
        return;
      }
      if (this.hasLoadedOnce && !this.oauthNavigationActive && this.isPrimaryPage()) {
        this.requestNativeShellEvaluation(this.navigationGeneration);
      }
    }

    this.consumePendingWebAction();
  }

  private consumePendingWebAction(): void {
    if (this.pendingWebAction !== PendingWebAction.RELOAD ||
      !this.webDestinationActive || !this.webControllerAttached) {
      return;
    }

    try {
      this.controller.refresh();
      this.pendingWebAction = PendingWebAction.NONE;
    } catch (_) {
      // Keep the action pending until a later active-and-attached reconcile.
    }
  }

  private triggerTouchFeedback(): void {
    HapticFeedbackService.touch().catch(() => {});
  }

  private prepareFreshWebInstance(): void {
    this.clearDeferredShellEvaluation();
    this.shellLifecycleBridge.detach();
    this.invalidateActiveDownloads();
    this.controller = new webview.WebviewController();
    this.downloadDelegate = new webview.WebDownloadDelegate();
    this.downloadDelegateConfigured = false;
    this.webControllerEpoch = this.webInstanceEpoch;
    this.navigationGeneration = 0;
    this.shellEvaluationClock = new ShellEvaluationClock();
    this.shellLifecycleBridge = new ShellLifecycleBridge(this.controller);
    this.shellLifecycleActive = false;
    this.shellLifecycleReconciledActive = false;
    this.shellLifecycleEpoch += 1;
    this.webControllerAttached = false;
    this.webDestinationActive = false;
    this.webDestinationVisible = false;
    this.webInstanceNeedsReset = false;
    this.workspaceUiFixtureLoaded = false;
    this.pendingWebAction = PendingWebAction.NONE;
    this.webBackRequestPending = false;
    this.loading = true;
    this.progress = 0;
    this.loadFailed = false;
    this.hasLoadedOnce = false;
    this.nativeShellReady = false;
    this.nativeHeaderControlsVisible = false;
    this.oauthNavigationActive = false;
    this.externalAuthHost = '';
    this.pendingOauthUrl = '';
    this.pendingOauthHost = '';
  }

  private currentPathNames(): string[] {
    try {
      return this.pathStack.getAllPathName();
    } catch (_) {
      return [];
    }
  }

  private openInitialConversation(): void {
    if (!shouldOpenInitialConversation(this.currentPathNames())) {
      return;
    }
    this.openConversation(false);
  }

  private openConversation(withFeedback: boolean = true): void {
    const pathNames: string[] = this.currentPathNames();
    const webAlreadyOpen: boolean = hasRoute(pathNames, AURORA_WEB_ROUTE);
    if (!shouldPushRoute(pathNames, AURORA_WEB_ROUTE)) {
      return;
    }
    if (shouldCreateFreshWebController(webAlreadyOpen) || this.webInstanceNeedsReset) {
      this.prepareFreshWebInstance();
    }
    if (withFeedback) {
      this.triggerTouchFeedback();
    }
    this.pathStack.pushPath({ name: AURORA_WEB_ROUTE });
  }

  private openSettings(): void {
    const pathNames: string[] = this.currentPathNames();
    if (!shouldPushRoute(pathNames, AURORA_SETTINGS_ROUTE)) {
      return;
    }
    this.triggerTouchFeedback();
    this.pathStack.pushPath({ name: AURORA_SETTINGS_ROUTE });
  }

  private openPrivacyDetails(): void {
    const pathNames: string[] = this.currentPathNames();
    if (!shouldPushRoute(pathNames, AURORA_PRIVACY_ROUTE)) {
      return;
    }
    this.triggerTouchFeedback();
    this.pathStack.pushPath({ name: AURORA_PRIVACY_ROUTE });
  }

  private openAboutDetails(): void {
    const pathNames: string[] = this.currentPathNames();
    if (!shouldPushRoute(pathNames, AURORA_ABOUT_ROUTE)) {
      return;
    }
    this.triggerTouchFeedback();
    this.pathStack.pushPath({ name: AURORA_ABOUT_ROUTE });
  }

  private popNativeDestination(): void {
    this.triggerTouchFeedback();
    try {
      this.pathStack.pop();
    } catch (_) {
      // The system back gesture may have completed the same transition.
    }
  }

  private reloadFromSettings(): void {
    const hasWebDestination: boolean = hasRoute(this.currentPathNames(), AURORA_WEB_ROUTE);
    this.triggerTouchFeedback();
    try {
      this.pathStack.pop();
    } catch (_) {
      return;
    }
    if (hasWebDestination) {
      this.pendingWebAction = PendingWebAction.RELOAD;
      this.reconcileWebLifecycle();
      return;
    }
    this.openConversation(false);
  }

  private openInSystemBrowser(): void {
    this.triggerTouchFeedback();
    this.openExternalUrl(APP_HOME_URL);
  }

  private openSystemShare(): void {
    this.triggerTouchFeedback();
    try {
      SystemShareService.showAurora(this.getAbilityContext())
        .then((shown: boolean) => {
          if (!shown) {
            this.showToast($r('app.string.share_failed'));
          }
        })
        .catch(() => {
          this.showToast($r('app.string.share_failed'));
        });
    } catch (_) {
      this.showToast($r('app.string.share_failed'));
    }
  }

  private getAbilityContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private showToast(message: Resource): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message });
    } catch (_) {
      // A toast failure must not interrupt navigation handling.
    }
  }

  private isPrimaryPage(): boolean {
    try {
      return isPrimaryAppOrigin(this.controller.getUrl());
    } catch (_) {
      return false;
    }
  }

  private currentPageUrl(): string {
    try {
      return this.controller.getUrl();
    } catch (_) {
      return '';
    }
  }

  private clearDeferredShellEvaluation(): void {
    if (this.shellEvaluationTimerId < 0) {
      return;
    }
    clearTimeout(this.shellEvaluationTimerId);
    this.shellEvaluationTimerId = -1;
  }

  private canEvaluateNativeShell(startedGeneration: number, startedEpoch: number): boolean {
    return this.shellLifecycleActive &&
      startedEpoch === this.shellLifecycleEpoch &&
      startedGeneration === this.navigationGeneration &&
      !this.oauthNavigationActive &&
      this.isPrimaryPage();
  }

  private requestNativeShellEvaluation(startedGeneration: number): void {
    const startedEpoch: number = this.shellLifecycleEpoch;
    if (!this.canEvaluateNativeShell(startedGeneration, startedEpoch)) {
      return;
    }
    const request: ShellEvaluationRequest = this.shellEvaluationClock.request(startedGeneration);
    if (request === ShellEvaluationRequest.REJECTED) {
      return;
    }

    this.nativeShellReady = false;
    this.nativeHeaderControlsVisible = false;
    if (request === ShellEvaluationRequest.STARTED) {
      this.runNativeShellEvaluation(startedGeneration, startedEpoch);
    }
  }

  private handleShellLifecycleSignal(startedGeneration: number): void {
    const startedEpoch: number = this.shellLifecycleEpoch;
    if (!this.canEvaluateNativeShell(startedGeneration, startedEpoch)) {
      return;
    }
    const request: ShellEvaluationRequest = this.shellEvaluationClock.request(startedGeneration);
    if (request === ShellEvaluationRequest.REJECTED) {
      return;
    }

    this.nativeShellReady = false;
    this.nativeHeaderControlsVisible = false;
    if (request === ShellEvaluationRequest.QUEUED) {
      return;
    }

    // The proxy method authenticates its calling frame synchronously. Defer
    // ArkWeb script execution until after that JavaScript-to-native call exits.
    try {
      this.shellEvaluationTimerId = setTimeout(() => {
        this.shellEvaluationTimerId = -1;
        if (!this.canEvaluateNativeShell(startedGeneration, startedEpoch)) {
          if (startedEpoch === this.shellLifecycleEpoch) {
            this.shellEvaluationClock.cancel(startedGeneration);
          }
          return;
        }
        this.runNativeShellEvaluation(startedGeneration, startedEpoch);
      }, 0);
    } catch (_) {
      this.shellEvaluationClock.cancel(startedGeneration);
    }
  }

  private runNativeShellEvaluation(startedGeneration: number, startedEpoch: number): void {
    if (!this.canEvaluateNativeShell(startedGeneration, startedEpoch)) {
      if (startedEpoch === this.shellLifecycleEpoch) {
        this.shellEvaluationClock.cancel(startedGeneration);
      }
      return;
    }

    try {
      this.controller.runJavaScript(
        buildShellActivationScript(startedGeneration),
        (error: BusinessError, result: string) => {
          this.completeNativeShellEvaluation(
            startedGeneration,
            startedEpoch,
            Boolean(error),
            result
          );
        }
      );
    } catch (_) {
      this.completeNativeShellEvaluation(startedGeneration, startedEpoch, true, '');
    }
  }

  private completeNativeShellEvaluation(
    startedGeneration: number,
    startedEpoch: number,
    executionFailed: boolean,
    result: string
  ): void {
    if (!this.shellLifecycleActive || startedEpoch !== this.shellLifecycleEpoch ||
      startedGeneration !== this.navigationGeneration) {
      return;
    }

    const latestUrl: string = this.currentPageUrl();
    const ready: boolean = !executionFailed && shouldAcceptShellActivation(
      startedGeneration,
      this.navigationGeneration,
      latestUrl,
      result
    );
    const unsupported: boolean = !executionFailed &&
      isPrimaryAppOrigin(latestUrl) &&
      isShellUnsupportedResult(result);
    const exposeHeaderControls: boolean = ready && shouldExposeNativeHeaderControls(
      startedGeneration,
      this.navigationGeneration,
      latestUrl,
      result
    );
    const decision: ShellEvaluationDecision = this.shellEvaluationClock.completeEvaluation(
      startedGeneration,
      !ready && !unsupported
    );

    if (decision === ShellEvaluationDecision.STALE) {
      return;
    }
    if (decision === ShellEvaluationDecision.RETRY) {
      this.runNativeShellEvaluation(startedGeneration, startedEpoch);
      return;
    }
    if (decision === ShellEvaluationDecision.COMMIT) {
      this.nativeShellReady = ready;
      this.nativeHeaderControlsVisible = exposeHeaderControls;
      return;
    }

    this.nativeShellReady = false;
    this.nativeHeaderControlsVisible = false;
    this.runNativeShellRollback(startedGeneration, startedEpoch);
  }

  private runNativeShellRollback(startedGeneration: number, startedEpoch: number): void {
    if (!this.canEvaluateNativeShell(startedGeneration, startedEpoch)) {
      if (startedEpoch === this.shellLifecycleEpoch) {
        this.finishNativeShellRollback(startedGeneration, startedEpoch);
      }
      return;
    }

    try {
      this.controller.runJavaScript(
        buildShellRollbackScript(startedGeneration),
        (_error: BusinessError, _result: string) => {
          this.finishNativeShellRollback(startedGeneration, startedEpoch);
        }
      );
    } catch (_) {
      this.finishNativeShellRollback(startedGeneration, startedEpoch);
    }
  }

  private finishNativeShellRollback(startedGeneration: number, startedEpoch: number): void {
    if (!this.shellLifecycleActive || startedEpoch !== this.shellLifecycleEpoch ||
      startedGeneration !== this.navigationGeneration) {
      return;
    }
    const decision: ShellRollbackDecision =
      this.shellEvaluationClock.completeRollback(startedGeneration);
    if (decision === ShellRollbackDecision.RETRY) {
      this.runNativeShellEvaluation(startedGeneration, startedEpoch);
    }
  }

  private runWebAction(action: NativeWebAction): void {
    if (!this.nativeShellReady || !this.isPrimaryPage()) {
      this.showToast($r('app.string.web_action_unavailable'));
      return;
    }

    const startedGeneration: number = this.navigationGeneration;
    try {
      this.controller.runJavaScript(
        buildWebActionScript(action, startedGeneration),
        (error: BusinessError, result: string) => {
          if (startedGeneration !== this.navigationGeneration || !this.isPrimaryPage()) {
            return;
          }
          if (error || !shouldAcceptWebAction(
            startedGeneration,
            this.navigationGeneration,
            this.currentPageUrl(),
            result
          )) {
            this.showToast($r('app.string.web_action_unavailable'));
          }
        }
      );
    } catch (_) {
      this.showToast($r('app.string.web_action_unavailable'));
    }
  }

  private openExternalUrl(targetUrl: string): void {
    if (!isSafeExternalUrl(targetUrl)) {
      this.showToast($r('app.string.blocked_link'));
      return;
    }

    try {
      this.getAbilityContext().openLink(targetUrl)
        .catch(() => {
          this.showToast($r('app.string.external_link_failed'));
        });
    } catch (_) {
      this.showToast($r('app.string.external_link_failed'));
    }
  }

  private handleNavigation(targetUrl: string): boolean {
    if (this.oauthNavigationActive) {
      if (!isSafeExternalUrl(targetUrl)) {
        this.showToast($r('app.string.blocked_link'));
        return true;
      }
      if (isPrimaryAppOrigin(targetUrl)) {
        this.oauthNavigationActive = false;
        this.externalAuthHost = '';
      } else {
        this.externalAuthHost = safeHttpsHostname(targetUrl);
      }
      return false;
    }

    if (this.isPrimaryPage() && isOauthCandidateUrl(targetUrl)) {
      this.pendingOauthUrl = targetUrl;
      this.pendingOauthHost = safeHttpsHostname(targetUrl);
      return true;
    }

    const decision: NavigationDecision = classifyNavigationUrl(targetUrl);
    if (decision === NavigationDecision.IN_APP) {
      return false;
    }
    if (decision === NavigationDecision.EXTERNAL) {
      this.openExternalUrl(targetUrl);
      return true;
    }

    this.showToast($r('app.string.blocked_link'));
    return true;
  }

  private handleWebPermission(request: PermissionRequest): void {
    const resources: Array<string> = request.getAccessibleResource();
    const isMicrophoneOnly: boolean = resources.length === 1 &&
      resources[0] === ProtectedResourceType.AUDIO_CAPTURE;

    if (!isPrimaryAppOrigin(request.getOrigin()) || !isMicrophoneOnly) {
      request.deny();
      return;
    }

    const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    try {
      manager.requestPermissionsFromUser(this.getAbilityContext(), [MICROPHONE_PERMISSION])
        .then((result: PermissionRequestResult) => {
          if (result.authResults.length === 1 &&
            result.authResults[0] === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
            request.grant([ProtectedResourceType.AUDIO_CAPTURE]);
            return;
          }
          request.deny();
        })
        .catch(() => {
          request.deny();
        });
    } catch (_) {
      request.deny();
    }
  }

  private completeFileSelection(result: FileSelectorResult, files: Array<string>): void {
    try {
      result.handleFileList(files);
    } catch (_) {
      // The ArkWeb request may have been cancelled while the system picker was open.
    }
  }

  private handleFileSelection(param: FileSelectorParam, result: FileSelectorResult): void {
    if (!this.isPrimaryPage()) {
      this.completeFileSelection(result, []);
      return;
    }
    const mode: FileSelectorMode = param.getMode();
    if (mode === FileSelectorMode.FileOpenFolderMode || mode === FileSelectorMode.FileSaveMode) {
      this.completeFileSelection(result, []);
      return;
    }

    const maxSelectNumber: number = mode === FileSelectorMode.FileOpenMultipleMode ?
      MAX_SELECTABLE_FILES : 1;
    const options: picker.DocumentSelectOptions = { maxSelectNumber: maxSelectNumber };

    try {
      const documentPicker: picker.DocumentViewPicker =
        new picker.DocumentViewPicker(this.getAbilityContext());
      documentPicker.select(options)
        .then((files: Array<string>) => {
          this.completeFileSelection(result, files);
        })
        .catch(() => {
          this.completeFileSelection(result, []);
        });
    } catch (_) {
      this.completeFileSelection(result, []);
    }
  }

  private sanitizeFileName(candidate: string): string {
    let sanitized: string = '';
    const forbidden: string = '\\/:*?"<>|';
    for (let index: number = 0; index < candidate.length && sanitized.length < 120; index++) {
      const character: string = candidate.charAt(index);
      const code: number = candidate.charCodeAt(index);
      sanitized += code < 32 || forbidden.indexOf(character) >= 0 ? '_' : character;
    }
    if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
      return 'download';
    }
    return sanitized;
  }

  private getDownloadCacheDirectory(): string {
    return this.getAbilityContext().cacheDir + '/aurora-downloads';
  }

  private clearStaleDownloadCache(): void {
    try {
      const cacheDirectory: string = this.getDownloadCacheDirectory();
      const entries: Array<string> = fileIo.listFileSync(cacheDirectory);
      for (let index: number = 0; index < entries.length; index++) {
        const entry: string = entries[index];
        if (entry.length > 0 && entry.indexOf('/') < 0 && entry.indexOf('\\') < 0) {
          try {
            fileIo.unlinkSync(cacheDirectory + '/' + entry);
          } catch (_) {
            // Ignore a file that disappeared or cannot be removed during best-effort cleanup.
          }
        }
      }
    } catch (_) {
      // The dedicated directory normally does not exist before the first download.
    }
  }

  private cancelDownload(item: webview.WebDownloadItem): void {
    try {
      item.cancel();
    } catch (_) {
      // The download may already have been cancelled by ArkWeb.
    }
  }

  private clearDownloadTarget(
    guid: string,
    expectedEpoch?: number,
    expectedItem?: webview.WebDownloadItem
  ): void {
    const target: DownloadTarget | undefined = this.downloadTargets.get(guid);
    if (target === undefined) {
      return;
    }
    if ((expectedEpoch !== undefined && target.webInstanceEpoch !== expectedEpoch) ||
      (expectedItem !== undefined && target.item !== expectedItem)) {
      return;
    }
    this.downloadTargets.delete(guid);
    try {
      fileIo.unlinkSync(target.cachePath);
    } catch (_) {
      // The cache file can be absent when a download fails before it starts.
    }
  }

  private invalidateActiveDownloads(): void {
    // Invalidate first so a synchronous cancel callback is already stale.
    this.webInstanceEpoch += 1;
    const guids: string[] = [];
    this.downloadTargets.forEach((_target: DownloadTarget, guid: string) => {
      guids.push(guid);
    });
    for (let index: number = 0; index < guids.length; index++) {
      const guid: string = guids[index];
      const target: DownloadTarget | undefined = this.downloadTargets.get(guid);
      if (target !== undefined) {
        this.cancelDownload(target.item);
        this.clearDownloadTarget(guid, target.webInstanceEpoch, target.item);
      }
    }
  }

  private startDownload(item: webview.WebDownloadItem, delegateEpoch: number): void {
    let guid: string = '';
    try {
      if (delegateEpoch !== this.webInstanceEpoch) {
        this.cancelDownload(item);
        return;
      }
      if (!this.isPrimaryPage()) {
        this.cancelDownload(item);
        this.showToast($r('app.string.blocked_link'));
        return;
      }
      if (!isSafeDownloadUrl(item.getUrl())) {
        this.cancelDownload(item);
        this.showToast($r('app.string.blocked_link'));
        return;
      }
      guid = item.getGuid();
      const fileName: string = this.sanitizeFileName(item.getSuggestedFileName());
      const cacheDirectory: string = this.getDownloadCacheDirectory();
      fileIo.mkdirSync(cacheDirectory, true);
      const cachePath: string = cacheDirectory + '/' + this.sanitizeFileName(guid) + '-' + fileName;
      this.downloadTargets.set(
        guid,
        new DownloadTarget(cachePath, fileName, item, delegateEpoch)
      );
      item.start(cachePath);
    } catch (_) {
      if (guid.length > 0) {
        this.clearDownloadTarget(guid, delegateEpoch, item);
      }
      this.cancelDownload(item);
      this.showToast($r('app.string.download_failed'));
    }
  }

  private async persistCompletedDownload(
    item: webview.WebDownloadItem,
    delegateEpoch: number
  ): Promise<void> {
    let guid: string = '';
    let destination: fileIo.File | undefined = undefined;
    try {
      guid = item.getGuid();
      const target: DownloadTarget | undefined = this.downloadTargets.get(guid);
      if (target === undefined || !isCurrentDownloadCallback(
        delegateEpoch,
        target.webInstanceEpoch,
        this.webInstanceEpoch
      )) {
        return;
      }
      const documentPicker: picker.DocumentViewPicker =
        new picker.DocumentViewPicker(this.getAbilityContext());
      const destinations: Array<string> = await documentPicker.save({
        newFileNames: [target.fileName]
      });
      if (destinations.length !== 1) {
        return;
      }
      if (!isCurrentDownloadCallback(
        delegateEpoch,
        target.webInstanceEpoch,
        this.webInstanceEpoch
      )) {
        return;
      }
      destination = await fileIo.open(
        destinations[0],
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC
      );
      await fileIo.copyFile(target.cachePath, destination.fd);
      if (isCurrentDownloadCallback(
        delegateEpoch,
        target.webInstanceEpoch,
        this.webInstanceEpoch
      )) {
        this.showToast($r('app.string.download_saved'));
      }
    } catch (_) {
      if (delegateEpoch === this.webInstanceEpoch) {
        this.showToast($r('app.string.download_failed'));
      }
    } finally {
      if (destination !== undefined) {
        try {
          fileIo.closeSync(destination);
        } catch (_) {
          // The destination descriptor may already be closed after an I/O failure.
        }
      }
      if (guid.length > 0) {
        this.clearDownloadTarget(guid, delegateEpoch, item);
      }
    }
  }

  private configureDownloadDelegate(): void {
    if (this.downloadDelegateConfigured) {
      return;
    }
    try {
      const delegateEpoch: number = this.webControllerEpoch;
      this.downloadDelegate.onBeforeDownload((item: webview.WebDownloadItem) => {
        this.startDownload(item, delegateEpoch);
      });
      this.downloadDelegate.onDownloadFinish((item: webview.WebDownloadItem) => {
        this.persistCompletedDownload(item, delegateEpoch).catch(() => {
          if (delegateEpoch === this.webInstanceEpoch) {
            this.showToast($r('app.string.download_failed'));
          }
        });
      });
      this.downloadDelegate.onDownloadFailed((item: webview.WebDownloadItem) => {
        try {
          this.clearDownloadTarget(item.getGuid(), delegateEpoch, item);
        } catch (_) {
          // The failed item may not expose a GUID after renderer shutdown.
        }
        if (delegateEpoch === this.webInstanceEpoch) {
          this.showToast($r('app.string.download_failed'));
        }
      });
      this.controller.setDownloadDelegate(this.downloadDelegate);
      this.downloadDelegateConfigured = true;
    } catch (_) {
      if (this.webControllerEpoch === this.webInstanceEpoch) {
        this.showToast($r('app.string.download_failed'));
      }
    }
  }

  private cancelOauthNavigation(): void {
    this.oauthNavigationActive = false;
    this.externalAuthHost = '';
    try {
      this.controller.loadUrl(WORKSPACE_INITIAL_URL);
    } catch (_) {
      this.loadFailed = true;
    }
  }

  private dismissOauthCandidate(): void {
    this.pendingOauthUrl = '';
    this.pendingOauthHost = '';
  }

  private continueOauthNavigation(): void {
    const targetUrl: string = this.pendingOauthUrl;
    const targetHost: string = this.pendingOauthHost;
    this.dismissOauthCandidate();

    if (!this.isPrimaryPage() || targetHost.length === 0 || !isOauthCandidateUrl(targetUrl)) {
      this.showToast($r('app.string.blocked_link'));
      return;
    }

    this.oauthNavigationActive = true;
    this.externalAuthHost = targetHost;
    try {
      this.controller.loadUrl(targetUrl);
    } catch (_) {
      this.oauthNavigationActive = false;
      this.externalAuthHost = '';
      this.showToast($r('app.string.external_link_failed'));
    }
  }

  private retry(): void {
    this.loadFailed = false;
    this.loading = true;
    this.progress = 0;
    try {
      this.controller.refresh();
    } catch (_) {
      try {
        this.controller.loadUrl(WORKSPACE_INITIAL_URL);
      } catch (_) {
        this.loading = false;
        this.loadFailed = true;
      }
    }
  }

  private canNavigateWebBackward(): boolean {
    try {
      return this.controller.accessBackward();
    } catch (_) {
      return false;
    }
  }

  private requestAppBackground(): void {
    if (this.appBackgroundRequestPending) {
      return;
    }

    this.appBackgroundRequestPending = true;
    this.triggerTouchFeedback();
    try {
      this.getAbilityContext().moveAbilityToBackground()
        .then(() => {
          this.appBackgroundRequestPending = false;
        })
        .catch((error: BusinessError) => {
          this.appBackgroundRequestPending = false;
          if (shouldTerminateAfterBackgroundFailure(error.code)) {
            this.terminateUnsupportedPrimarySurface();
          }
        });
    } catch (error) {
      this.appBackgroundRequestPending = false;
      const errorCode: number | undefined = (error as BusinessError | undefined)?.code;
      if (shouldTerminateAfterBackgroundFailure(errorCode)) {
        this.terminateUnsupportedPrimarySurface();
      }
    }
  }

  private terminateUnsupportedPrimarySurface(): void {
    try {
      this.getAbilityContext().terminateSelf().catch(() => {});
    } catch (_) {
      // The system keeps the current surface when neither background nor
      // termination is supported by this device category.
    }
  }

  private continueOrdinaryWebBack(): void {
    const action: WebBackAction = decideWebBack(
      false,
      false,
      this.canNavigateWebBackward()
    );
    if (action === WebBackAction.WEB_BACKWARD) {
      try {
        this.controller.backward();
      } catch (_) {
        // A subsequent back press can safely re-evaluate controller state.
      }
      return;
    }
    this.requestAppBackground();
  }

  private dismissTopLayerOrContinueBack(): void {
    if (this.webBackRequestPending) {
      return;
    }
    if (!shouldAttemptTopLayerDismiss(this.shellLifecycleActive, this.isPrimaryPage())) {
      this.continueOrdinaryWebBack();
      return;
    }

    const startedGeneration: number = this.navigationGeneration;
    const startedEpoch: number = this.shellLifecycleEpoch;
    this.webBackRequestPending = true;
    try {
      this.controller.runJavaScript(
        buildTopLayerDismissScript(startedGeneration),
        (error: BusinessError, result: string) => {
          this.webBackRequestPending = false;
          if (!this.shellLifecycleActive || startedEpoch !== this.shellLifecycleEpoch ||
            startedGeneration !== this.navigationGeneration || !this.isPrimaryPage()) {
            return;
          }
          if (!error && shouldAcceptTopLayerDismiss(
            startedGeneration,
            this.navigationGeneration,
            this.currentPageUrl(),
            result
          )) {
            return;
          }
          this.continueOrdinaryWebBack();
        }
      );
    } catch (_) {
      this.webBackRequestPending = false;
      this.continueOrdinaryWebBack();
    }
  }

  private handleWebBackPress(): boolean {
    if (this.pendingOauthUrl.length > 0) {
      this.dismissOauthCandidate();
      return true;
    }

    if (this.oauthNavigationActive) {
      const oauthAction: WebBackAction = decideWebBack(
        false,
        true,
        this.canNavigateWebBackward()
      );
      if (oauthAction === WebBackAction.WEB_BACKWARD) {
        try {
          this.controller.backward();
        } catch (_) {
          // A subsequent back press can safely re-evaluate controller state.
        }
      } else {
        this.cancelOauthNavigation();
      }
      return true;
    }

    this.dismissTopLayerOrContinueBack();
    return true;
  }

  @Builder
  private auroraDestination(name: string): void {
    if (name === AURORA_WEB_ROUTE) {
      NavDestination() {
        this.webContent()
      }
      .hideTitleBar(true)
      .onShown(() => {
        this.webDestinationVisible = true;
        this.reconcileWebLifecycle();
      })
      .onHidden(() => {
        this.webDestinationVisible = false;
        this.reconcileWebLifecycle();
      })
      .onActive(() => {
        this.webDestinationActive = true;
        this.reconcileWebLifecycle();
      })
      .onInactive(() => {
        this.webDestinationActive = false;
        this.reconcileWebLifecycle();
      })
      .onBackPressed(() => this.handleWebBackPress())
    } else if (name === AURORA_SETTINGS_ROUTE) {
      NavDestination() {
        SettingsPage({
          online: this.online,
          onBack: () => this.popNativeDestination(),
          onReload: () => this.reloadFromSettings(),
          onOpenBrowser: () => this.openInSystemBrowser(),
          onSystemShare: () => this.openSystemShare(),
          onOpenPrivacy: () => this.openPrivacyDetails(),
          onOpenAbout: () => this.openAboutDetails()
        })
      }
      .hideTitleBar(true)
      .onBackPressed(() => {
        this.popNativeDestination();
        return true;
      })
    } else if (name === AURORA_PRIVACY_ROUTE) {
      NavDestination() {
        SettingsDetailPage({
          pageKind: SettingsDetailPageKind.PRIVACY,
          onBack: () => this.popNativeDestination()
        })
      }
      .hideTitleBar(true)
      .onBackPressed(() => {
        this.popNativeDestination();
        return true;
      })
    } else if (name === AURORA_ABOUT_ROUTE) {
      NavDestination() {
        SettingsDetailPage({
          pageKind: SettingsDetailPageKind.ABOUT,
          onBack: () => this.popNativeDestination()
        })
      }
      .hideTitleBar(true)
      .onBackPressed(() => {
        this.popNativeDestination();
        return true;
      })
    }
  }

  @Builder
  private shellIconButton(
    symbol: Resource,
    label: Resource,
    stableId: string,
    action: NativeWebAction
  ): void {
    Button() {
      SymbolGlyph(symbol)
        .fontSize(21)
        .fontColor([$r('app.color.primary_text')])
    }
    .type(ButtonType.Normal)
    .width(44)
    .height(44)
    .padding(0)
    .borderRadius(22)
    .backgroundColor(Color.Transparent)
    .hitTestBehavior(HitTestMode.Block)
    .id(stableId)
    .accessibilityText(label)
    .onClick(() => this.runWebAction(action))
  }

  @Builder
  private nativeHeaderOverlay(): void {
    Row() {
      this.shellIconButton(
        $r('sys.symbol.line_2_horizontal'),
        $r('app.string.open_sessions'),
        'aurora-web-open-sessions',
        NativeWebAction.OPEN_SESSIONS
      )

      Blank()
      .layoutWeight(1)

      Button() {
        SymbolGlyph($r('sys.symbol.ellipsis_circle'))
          .fontSize(21)
          .fontColor([$r('app.color.primary_text')])
      }
      .type(ButtonType.Normal)
      .width(44)
      .height(44)
      .padding(0)
      .borderRadius(22)
      .backgroundColor(Color.Transparent)
      .hitTestBehavior(HitTestMode.Block)
      .id('aurora-web-open-settings')
      .accessibilityText($r('app.string.open_more'))
      .onClick(() => this.openSettings())
    }
    .width('100%')
    .height(52)
    .padding({ left: 6, right: 6, top: 4, bottom: 4 })
    .hitTestBehavior(HitTestMode.Transparent)
  }

  @Builder
  private offlineBanner(): void {
    Row({ space: 10 }) {
      SymbolGlyph($r('sys.symbol.wifi'))
        .fontSize(20)
        .fontColor([$r('app.color.offline_text')])

      Column({ space: 1 }) {
        Text($r('app.string.offline'))
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.offline_text'))
        Text($r('app.string.offline_hint'))
          .fontSize(11)
          .fontColor($r('app.color.offline_text'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 6, bottom: 6 })
    .backgroundColor($r('app.color.offline_background'))
  }

  @Builder
  private webContent(): void {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        if (this.externalAuthHost.length > 0) {
          Row({ space: 10 }) {
            Column({ space: 2 }) {
              Text($r('app.string.external_authorization'))
                .fontSize(12)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.primary_text'))
              Text(this.externalAuthHost)
                .fontSize(11)
                .fontColor($r('app.color.secondary_text'))
                .wordBreak(WordBreak.BREAK_ALL)
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            Button($r('app.string.cancel_authorization'))
              .type(ButtonType.Normal)
              .fontSize(12)
              .fontColor($r('app.color.brand_primary'))
              .backgroundColor(Color.Transparent)
              .id('aurora-oauth-cancel-active')
              .onClick(() => this.cancelOauthNavigation())
          }
          .width('100%')
          .constraintSize({ minHeight: 56 })
          .padding({ left: 16, right: 10, top: 8, bottom: 8 })
          .backgroundColor($r('app.color.auth_bar_background'))
          .border({
            width: { bottom: 1 },
            color: $r('app.color.auth_bar_border')
          })
        }

        Web({ src: WORKSPACE_INITIAL_URL, controller: this.controller })
        .width('100%')
        .layoutWeight(1)
        .javaScriptAccess(true)
        .javaScriptProxy({
          object: this.shellLifecycleBridge,
          name: SHELL_LIFECYCLE_BRIDGE_NAME,
          methodList: [SHELL_LIFECYCLE_BRIDGE_METHOD],
          asyncMethodList: [],
          controller: this.controller,
          permission: SHELL_LIFECYCLE_PERMISSION
        })
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        .onlineImageAccess(true)
        .mixedMode(MixedMode.None)
        .multiWindowAccess(false)
        .allowWindowOpenMethod(false)
        .onControllerAttached(() => {
          this.webControllerAttached = true;
          this.configureDownloadDelegate();
          this.reconcileWebLifecycle();
        })
        .onLoadIntercept((event) => {
          if (!event.data.isMainFrame()) {
            return false;
          }
          const requestUrl: string = event.data.getRequestUrl();
          if (shouldAllowWorkspaceUiFixtureLoadUrl(requestUrl)) {
            return false;
          }
          return this.handleNavigation(requestUrl);
        })
        .onPermissionRequest((event) => {
          this.handleWebPermission(event.request);
        })
        .onShowFileSelector((event) => {
          this.handleFileSelection(event.fileSelector, event.result);
          return true;
        })
        .onPageBegin(() => {
          this.clearDeferredShellEvaluation();
          this.navigationGeneration += 1;
          this.shellEvaluationClock.beginGeneration(this.navigationGeneration);
          this.nativeShellReady = false;
          this.nativeHeaderControlsVisible = false;
          this.loading = !this.oauthNavigationActive;
          this.loadFailed = false;
          this.progress = 0;
        })
        .onProgressChange((event) => {
          this.progress = event.newProgress;
        })
        .onPageEnd((event) => {
          if (!this.workspaceUiFixtureLoaded &&
            isWorkspaceUiFixtureBootstrapUrl(event.url)) {
            this.workspaceUiFixtureLoaded = loadWorkspaceUiFixture(this.controller);
            if (this.workspaceUiFixtureLoaded) {
              return;
            }
          }
          this.loading = false;
          this.progress = 100;
          this.hasLoadedOnce = true;
          const completedGeneration: number = this.navigationGeneration;
          if (!this.oauthNavigationActive && this.isPrimaryPage()) {
            this.requestNativeShellEvaluation(completedGeneration);
          }
        })
        .onErrorReceive((event) => {
          if (event.request.isMainFrame()) {
            this.loading = false;
            this.loadFailed = true;
          }
        })
      }
      .width('100%')
      .height('100%')

      if (this.nativeShellReady && this.nativeHeaderControlsVisible &&
        this.externalAuthHost.length === 0) {
        this.nativeHeaderOverlay()
      }

      if (this.nativeShellReady && this.nativeHeaderControlsVisible && !this.online &&
        this.externalAuthHost.length === 0) {
        Column() {
          this.offlineBanner()
        }
        .width('100%')
        .margin({ top: 52 })
      }

      if (this.loading && this.hasLoadedOnce && this.nativeShellReady &&
        this.nativeHeaderControlsVisible) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(2)
          .margin({ top: this.online ? 52 : 100 })
          .color($r('app.color.brand_primary'))
          .backgroundColor(Color.Transparent)
      }

      if (this.loading && !this.loadFailed && !this.hasLoadedOnce) {
        Column({ space: 18 }) {
          Image($r('app.media.aurora_icon'))
            .width(72)
            .height(72)
            .borderRadius(18)

          Text($r('app.string.loading'))
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.primary_text'))

          Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
            .width(160)
            .height(4)
            .color($r('app.color.brand_primary'))
            .backgroundColor($r('app.color.progress_track'))
        }
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.page_background'))
      }

      if (this.loadFailed) {
        Column({ space: 16 }) {
          Image($r('app.media.aurora_icon'))
            .width(64)
            .height(64)
            .borderRadius(16)

          Text($r('app.string.load_failed'))
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.primary_text'))

          Text($r('app.string.load_failed_hint'))
            .fontSize(14)
            .fontColor($r('app.color.secondary_text'))
            .textAlign(TextAlign.Center)

          Button($r('app.string.retry'))
            .fontColor(Color.White)
            .backgroundColor($r('app.color.brand_primary'))
            .borderRadius(20)
            .id('aurora-web-retry')
            .onClick(() => this.retry())
        }
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .padding({ left: 32, right: 32 })
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.page_background'))
      }

      if (this.pendingOauthUrl.length > 0) {
        Column({ space: 18 }) {
          Text($r('app.string.authorization_prompt_title'))
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.primary_text'))

          Text($r('app.string.authorization_prompt_hint'))
            .fontSize(14)
            .fontColor($r('app.color.secondary_text'))
            .textAlign(TextAlign.Center)

          Text(this.pendingOauthHost)
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.primary_text'))
            .textAlign(TextAlign.Center)
            .wordBreak(WordBreak.BREAK_ALL)
            .width('100%')

          Row({ space: 12 }) {
            Button($r('app.string.cancel_authorization'))
              .layoutWeight(1)
              .fontColor($r('app.color.primary_text'))
              .backgroundColor($r('app.color.auth_bar_background'))
              .borderRadius(20)
              .id('aurora-oauth-cancel-pending')
              .onClick(() => this.dismissOauthCandidate())

            Button($r('app.string.continue_authorization'))
              .layoutWeight(1)
              .fontColor(Color.White)
              .backgroundColor($r('app.color.brand_primary'))
              .borderRadius(20)
              .id('aurora-oauth-continue')
              .onClick(() => this.continueOauthNavigation())
          }
          .width('100%')
        }
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .padding({ left: 28, right: 28 })
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.page_background'))
      }
    }
    .width('100%')
    .height('100%')
    .id('aurora-web-screen')
    .accessibilityDescription(workspaceUiControllerDescription(this.webControllerEpoch))
    .backgroundColor($r('app.color.page_background'))
  }

  @Builder
  private launchSurface(): void {
    Column({ space: 20 }) {
      Image($r('app.media.aurora_icon'))
        .width(56)
        .height(56)
        .borderRadius(16)
        .accessibilityText($r('app.string.loading'))

      LoadingProgress()
        .width(22)
        .height(22)
        .color($r('app.color.brand_primary'))
    }
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .width('100%')
    .height('100%')
    .id('aurora-launch-screen')
    .backgroundColor($r('app.color.page_background'))
  }

  build() {
    Navigation(this.pathStack) {
      this.launchSurface()
    }
    .navDestination(this.auroraDestination)
    .hideTitleBar(true)
    .width('100%')
    .height('100%')
    .onAppear(() => this.openInitialConversation())
  }
}
