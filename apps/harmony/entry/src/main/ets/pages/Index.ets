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
  buildWebActionScript,
  isShellUnsupportedResult,
  NativeWebAction,
  SHELL_LIFECYCLE_BRIDGE_METHOD,
  SHELL_LIFECYCLE_BRIDGE_NAME,
  shouldAcceptShellActivation,
  shouldAcceptWebAction
} from '../common/NativeShellPolicy';
import {
  ShellEvaluationClock,
  ShellEvaluationDecision,
  ShellEvaluationRequest,
  ShellRollbackDecision
} from '../common/ShellEvaluationClock';
import { NetworkMonitor } from '../services/NetworkMonitor';
import {
  SHELL_LIFECYCLE_PERMISSION,
  ShellLifecycleBridge
} from '../services/ShellLifecycleBridge';

const MICROPHONE_PERMISSION: Permissions = 'ohos.permission.MICROPHONE';
const MAX_SELECTABLE_FILES: number = 8;

class DownloadTarget {
  cachePath: string;
  fileName: string;

  constructor(cachePath: string, fileName: string) {
    this.cachePath = cachePath;
    this.fileName = fileName;
  }
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private pathStack: NavPathStack = new NavPathStack();
  private destinationOpened: boolean = false;
  private downloadDelegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  private downloadDelegateConfigured: boolean = false;
  private downloadTargets: Map<string, DownloadTarget> = new Map<string, DownloadTarget>();
  private navigationGeneration: number = 0;
  private readonly shellEvaluationClock: ShellEvaluationClock = new ShellEvaluationClock();
  private readonly shellLifecycleBridge: ShellLifecycleBridge =
    new ShellLifecycleBridge(this.controller);
  private shellLifecycleActive: boolean = false;
  private shellLifecycleEpoch: number = 0;
  private shellEvaluationTimerId: number = -1;
  private networkMonitor: NetworkMonitor | undefined = undefined;

  @State private loading: boolean = true;
  @State private progress: number = 0;
  @State private loadFailed: boolean = false;
  @State private hasLoadedOnce: boolean = false;
  @State private nativeShellReady: boolean = false;
  @State private online: boolean = true;
  @State private settingsVisible: boolean = false;
  @State private oauthNavigationActive: boolean = false;
  @State private externalAuthHost: string = '';
  @State private pendingOauthUrl: string = '';
  @State private pendingOauthHost: string = '';

  aboutToAppear(): void {
    if (!this.shellLifecycleActive) {
      this.shellLifecycleActive = true;
      this.shellLifecycleEpoch += 1;
      this.shellEvaluationClock.beginGeneration(this.navigationGeneration);
      this.shellLifecycleBridge.attach((generation: number) => {
        this.handleShellLifecycleSignal(generation);
      });
    }
    if (this.networkMonitor === undefined) {
      this.networkMonitor = new NetworkMonitor((online: boolean) => {
        this.online = online;
      });
    }
    this.networkMonitor.start();
    if (!this.destinationOpened) {
      this.clearStaleDownloadCache();
      this.destinationOpened = true;
      this.pathStack.pushPath({ name: 'aurora-web' }, false);
    }
  }

  aboutToDisappear(): void {
    this.shellLifecycleActive = false;
    this.shellLifecycleEpoch += 1;
    this.shellLifecycleBridge.detach();
    this.clearDeferredShellEvaluation();
    this.shellEvaluationClock.invalidate();
    this.nativeShellReady = false;
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
      return;
    }

    this.nativeShellReady = false;
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
    this.settingsVisible = false;
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

  private reloadConversation(): void {
    this.settingsVisible = false;
    this.retry();
  }

  private openInSystemBrowser(): void {
    this.settingsVisible = false;
    this.openExternalUrl(APP_HOME_URL);
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

  private clearDownloadTarget(guid: string): void {
    const target: DownloadTarget | undefined = this.downloadTargets.get(guid);
    this.downloadTargets.delete(guid);
    if (target === undefined) {
      return;
    }
    try {
      fileIo.unlinkSync(target.cachePath);
    } catch (_) {
      // The cache file can be absent when a download fails before it starts.
    }
  }

  private startDownload(item: webview.WebDownloadItem): void {
    let guid: string = '';
    try {
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
      this.downloadTargets.set(guid, new DownloadTarget(cachePath, fileName));
      item.start(cachePath);
    } catch (_) {
      if (guid.length > 0) {
        this.clearDownloadTarget(guid);
      }
      this.cancelDownload(item);
      this.showToast($r('app.string.download_failed'));
    }
  }

  private async persistCompletedDownload(item: webview.WebDownloadItem): Promise<void> {
    let guid: string = '';
    let destination: fileIo.File | undefined = undefined;
    try {
      guid = item.getGuid();
      const target: DownloadTarget | undefined = this.downloadTargets.get(guid);
      if (target === undefined) {
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
      destination = await fileIo.open(
        destinations[0],
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC
      );
      await fileIo.copyFile(target.cachePath, destination.fd);
      this.showToast($r('app.string.download_saved'));
    } catch (_) {
      this.showToast($r('app.string.download_failed'));
    } finally {
      if (destination !== undefined) {
        try {
          fileIo.closeSync(destination);
        } catch (_) {
          // The destination descriptor may already be closed after an I/O failure.
        }
      }
      if (guid.length > 0) {
        this.clearDownloadTarget(guid);
      }
    }
  }

  private configureDownloadDelegate(): void {
    if (this.downloadDelegateConfigured) {
      return;
    }
    try {
      this.downloadDelegate.onBeforeDownload((item: webview.WebDownloadItem) => {
        this.startDownload(item);
      });
      this.downloadDelegate.onDownloadFinish((item: webview.WebDownloadItem) => {
        this.persistCompletedDownload(item).catch(() => {
          this.showToast($r('app.string.download_failed'));
        });
      });
      this.downloadDelegate.onDownloadFailed((item: webview.WebDownloadItem) => {
        try {
          this.clearDownloadTarget(item.getGuid());
        } catch (_) {
          // The failed item may not expose a GUID after renderer shutdown.
        }
        this.showToast($r('app.string.download_failed'));
      });
      this.controller.setDownloadDelegate(this.downloadDelegate);
      this.downloadDelegateConfigured = true;
    } catch (_) {
      this.showToast($r('app.string.download_failed'));
    }
  }

  private cancelOauthNavigation(): void {
    this.oauthNavigationActive = false;
    this.externalAuthHost = '';
    try {
      this.controller.loadUrl(APP_HOME_URL);
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
        this.controller.loadUrl(APP_HOME_URL);
      } catch (_) {
        this.loading = false;
        this.loadFailed = true;
      }
    }
  }

  private handleBackPress(): boolean {
    if (this.settingsVisible) {
      this.settingsVisible = false;
      return true;
    }

    if (this.pendingOauthUrl.length > 0) {
      this.dismissOauthCandidate();
      return true;
    }

    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (_) {
      // The controller can briefly be unavailable while ArkWeb is attaching.
    }

    try {
      this.getAbilityContext().terminateSelf().catch(() => {});
    } catch (_) {
      // The system will close the destination if the ability is already stopping.
    }
    return true;
  }

  @Builder
  private auroraDestination(_name: string): void {
    NavDestination() {
      this.webContent()
    }
    .hideTitleBar(true)
    .onBackPressed(() => this.handleBackPress())
  }

  @Builder
  private shellIconButton(symbol: Resource, label: Resource, action: NativeWebAction): void {
    Button() {
      SymbolGlyph(symbol)
        .fontSize(22)
        .fontColor([$r('app.color.primary_text')])
    }
    .type(ButtonType.Normal)
    .width(48)
    .height(48)
    .padding(0)
    .borderRadius(12)
    .backgroundColor(Color.Transparent)
    .accessibilityText(label)
    .onClick(() => this.runWebAction(action))
  }

  @Builder
  private nativeAppBar(): void {
    Row({ space: 4 }) {
      this.shellIconButton(
        $r('sys.symbol.open_sidebar'),
        $r('app.string.open_sessions'),
        NativeWebAction.OPEN_SESSIONS
      )

      Row() {
        Row({ space: 10 }) {
          Image($r('app.media.aurora_icon'))
            .width(32)
            .height(32)
            .borderRadius(9)

          Column({ space: 2 }) {
            Text('Aurora')
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.primary_text'))
              .maxLines(1)

            Row({ space: 5 }) {
              Circle()
                .width(6)
                .height(6)
                .fill(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
              if (this.online) {
                Text($r('app.string.connected'))
                  .fontSize(12)
                  .fontColor($r('app.color.secondary_text'))
              } else {
                Text($r('app.string.offline'))
                  .fontSize(12)
                  .fontColor($r('app.color.offline_text'))
              }
              Text('·')
                .fontSize(12)
                .fontColor($r('app.color.faint_text'))
              Text($r('app.string.model_and_agent'))
                .fontSize(12)
                .fontColor($r('app.color.secondary_text'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .height('100%')
      }
      .layoutWeight(1)
      .height(48)
      .padding({ left: 4, right: 8 })
      .borderRadius(12)
      .backgroundColor(Color.Transparent)

      Button() {
        SymbolGlyph($r('sys.symbol.more'))
          .fontSize(22)
          .fontColor([$r('app.color.primary_text')])
      }
      .type(ButtonType.Normal)
      .width(48)
      .height(48)
      .padding(0)
      .borderRadius(12)
      .backgroundColor(Color.Transparent)
      .accessibilityText($r('app.string.open_more'))
      .onClick(() => {
        this.settingsVisible = true;
      })
    }
    .width('100%')
    .height(56)
    .padding({ left: 4, right: 4 })
    .backgroundColor($r('app.color.surface_background'))
    .border({
      width: { bottom: 1 },
      color: $r('app.color.divider')
    })
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
  private webActionButton(label: Resource, action: NativeWebAction): void {
    Button(label)
      .type(ButtonType.Normal)
      .layoutWeight(1)
      .height(44)
      .fontSize(13)
      .fontColor($r('app.color.primary_text'))
      .backgroundColor($r('app.color.auth_bar_background'))
      .borderRadius(12)
      .onClick(() => this.runWebAction(action))
  }

  @Builder
  private appSettingsSheet(): void {
    Scroll() {
      Column({ space: 16 }) {
        Column({ space: 4 }) {
          Text($r('app.string.app_controls'))
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.primary_text'))
          Text($r('app.string.compatibility_mode'))
            .fontSize(12)
            .fontColor($r('app.color.secondary_text'))
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        Row({ space: 12 }) {
          Image($r('app.media.aurora_icon'))
            .width(40)
            .height(40)
            .borderRadius(12)
          Column({ space: 3 }) {
            Text(this.online ? $r('app.string.connected') : $r('app.string.offline'))
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
            Text('claudeai.chat')
              .fontSize(12)
              .fontColor($r('app.color.secondary_text'))
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .padding(14)
        .backgroundColor($r('app.color.auth_bar_background'))
        .borderRadius(16)

        Column({ space: 8 }) {
          Text($r('app.string.quick_actions'))
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.secondary_text'))
            .width('100%')

          Row({ space: 8 }) {
            Button($r('app.string.reload_chat'))
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .height(44)
              .fontSize(13)
              .fontColor(Color.White)
              .backgroundColor($r('app.color.brand_primary'))
              .borderRadius(12)
              .onClick(() => this.reloadConversation())
            Button($r('app.string.open_in_browser'))
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .height(44)
              .fontSize(13)
              .fontColor($r('app.color.primary_text'))
              .backgroundColor($r('app.color.auth_bar_background'))
              .borderRadius(12)
              .onClick(() => this.openInSystemBrowser())
          }
          .width('100%')

          Row({ space: 8 }) {
            this.webActionButton($r('app.string.media_tasks'), NativeWebAction.OPEN_MEDIA)
            this.webActionButton($r('app.string.tutorial'), NativeWebAction.OPEN_TUTORIAL)
          }
          .width('100%')

          Row({ space: 8 }) {
            this.webActionButton($r('app.string.inbox'), NativeWebAction.OPEN_INBOX)
            this.webActionButton($r('app.string.billing'), NativeWebAction.OPEN_BILLING)
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        Column({ space: 8 }) {
          Text($r('app.string.service_and_privacy'))
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.secondary_text'))
            .width('100%')
          Row() {
            Text($r('app.string.service_domain'))
              .fontSize(14)
              .fontColor($r('app.color.primary_text'))
            Blank()
            Text('claudeai.chat')
              .fontSize(13)
              .fontColor($r('app.color.secondary_text'))
          }
          .width('100%')
          .padding({ top: 4, bottom: 4 })
          Text($r('app.string.session_storage_hint'))
            .fontSize(12)
            .lineHeight(18)
            .fontColor($r('app.color.secondary_text'))
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(14)
        .backgroundColor($r('app.color.auth_bar_background'))
        .borderRadius(16)

        Column({ space: 4 }) {
          Text($r('app.string.about_app'))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.primary_text'))
          Text($r('app.string.app_version'))
            .fontSize(12)
            .fontColor($r('app.color.secondary_text'))
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 8, bottom: 24 })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Auto)
    .backgroundColor($r('app.color.surface_background'))
  }

  @Builder
  private webContent(): void {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        if (this.nativeShellReady && this.externalAuthHost.length === 0) {
          this.nativeAppBar()
        }

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

        if (this.nativeShellReady && !this.online && this.externalAuthHost.length === 0) {
          this.offlineBanner()
        }

        if (this.loading && this.hasLoadedOnce && this.nativeShellReady) {
          Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
            .width('100%')
            .height(2)
            .color($r('app.color.brand_primary'))
            .backgroundColor(Color.Transparent)
        }

        Web({ src: APP_HOME_URL, controller: this.controller })
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
          this.configureDownloadDelegate();
        })
        .onLoadIntercept((event) => {
          if (!event.data.isMainFrame()) {
            return false;
          }
          return this.handleNavigation(event.data.getRequestUrl());
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
          this.loading = !this.oauthNavigationActive;
          this.loadFailed = false;
          this.progress = 0;
        })
        .onProgressChange((event) => {
          this.progress = event.newProgress;
        })
        .onPageEnd(() => {
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
              .onClick(() => this.dismissOauthCandidate())

            Button($r('app.string.continue_authorization'))
              .layoutWeight(1)
              .fontColor(Color.White)
              .backgroundColor($r('app.color.brand_primary'))
              .borderRadius(20)
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
    .backgroundColor($r('app.color.page_background'))
    .bindSheet($$this.settingsVisible, this.appSettingsSheet(), {
      height: 600,
      dragBar: true,
      showClose: true,
      backgroundColor: $r('app.color.surface_background')
    })
  }

  build() {
    Navigation(this.pathStack) {
      Column() {
        Blank()
      }
    }
    .navDestination(this.auroraDestination)
    .hideNavBar(true)
    .hideTitleBar(true)
    .width('100%')
    .height('100%')
  }
}
