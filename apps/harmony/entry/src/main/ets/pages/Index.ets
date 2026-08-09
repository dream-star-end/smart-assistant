import {
  abilityAccessCtrl,
  common,
  PermissionRequestResult,
  Permissions
} from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
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

  @State private loading: boolean = true;
  @State private progress: number = 0;
  @State private loadFailed: boolean = false;
  @State private oauthNavigationActive: boolean = false;
  @State private externalAuthHost: string = '';
  @State private pendingOauthUrl: string = '';
  @State private pendingOauthHost: string = '';

  aboutToAppear(): void {
    if (!this.destinationOpened) {
      this.clearStaleDownloadCache();
      this.destinationOpened = true;
      this.pathStack.pushPath({ name: 'aurora-web' }, false);
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

        Web({ src: APP_HOME_URL, controller: this.controller })
        .width('100%')
        .layoutWeight(1)
        .javaScriptAccess(true)
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

      if (this.loading && !this.loadFailed) {
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
