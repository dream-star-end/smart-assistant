@Component
export struct SettingsPage {
  @Prop online: boolean = true;

  onBack: () => void = () => {};
  onReload: () => void = () => {};
  onOpenBrowser: () => void = () => {};
  onSystemShare: () => void = () => {};
  onOpenPrivacy: () => void = () => {};
  onOpenAbout: () => void = () => {};

  @Builder
  private titleBar(): void {
    Stack({ alignContent: Alignment.Center }) {
      Text($r('app.string.settings'))
        .fontSize(21)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.primary_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: 60, right: 60 })

      Row() {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(28)
            .fontColor([$r('app.color.brand_primary')])
            .accessibilityText($r('app.string.back'))
        }
        .type(ButtonType.Normal)
        .width(52)
        .height(52)
        .padding(0)
        .borderRadius(18)
        .backgroundColor(Color.Transparent)
        .id('aurora-settings-back')
        .accessibilityText($r('app.string.back'))
        .onClick(() => this.onBack())

        Blank()
      }
      .width('100%')
    }
    .width('100%')
    .constraintSize({ minHeight: 58 })
    .padding({ left: 8, right: 8, top: 3, bottom: 3 })
    .backgroundColor($r('app.color.page_background'))
  }

  @Builder
  private auroraStatusCard(): void {
    Button() {
      Row({ space: 16 }) {
        Image($r('app.media.aurora_icon'))
          .width(48)
          .height(48)
          .borderRadius(15)
          .accessibilityText($r('app.string.about_app'))

        Column({ space: 6 }) {
          Text('Aurora')
            .fontSize(21)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.primary_text'))
            .width('100%')
          Row({ space: 8 }) {
            Circle()
              .width(9)
              .height(9)
              .fill(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
              .accessibilityText(this.online ? $r('app.string.connected') : $r('app.string.offline'))
            Text(this.online ? $r('app.string.connected') : $r('app.string.offline'))
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(23)
          .fontColor([$r('app.color.faint_text')])
          .accessibilityText($r('app.string.about_app'))
      }
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 82 })
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .backgroundColor($r('app.color.surface_background'))
    .borderRadius(22)
    .clip(true)
    .id('aurora-settings-status-about')
    .accessibilityText($r('app.string.about_app'))
    .onClick(() => this.onOpenAbout())
  }

  @Builder
  private sectionTitle(title: Resource): void {
    Text(title)
      .fontSize(16)
      .fontWeight(FontWeight.Medium)
      .fontColor($r('app.color.secondary_text'))
      .width('100%')
      .padding({ left: 4 })
  }

  @Builder
  private actionRow(
    icon: Resource,
    title: Resource,
    stableId: string,
    action: () => void
  ): void {
    Button() {
      Row({ space: 15 }) {
        SymbolGlyph(icon)
          .fontSize(27)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText(title)

        Text(title)
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.primary_text'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)

        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(21)
          .fontColor([$r('app.color.faint_text')])
          .accessibilityText(title)
      }
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 60 })
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .borderRadius(0)
    .backgroundColor(Color.Transparent)
    .id(stableId)
    .accessibilityText(title)
    .onClick(action)
  }

  @Builder
  private detailActionRow(
    icon: Resource,
    title: Resource,
    hint: Resource,
    stableId: string,
    action: () => void
  ): void {
    Button() {
      Row({ space: 15 }) {
        SymbolGlyph(icon)
          .fontSize(27)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText(title)

        Column({ space: 4 }) {
          Text(title)
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.primary_text'))
            .width('100%')
          Text(hint)
            .fontSize(13)
            .fontColor($r('app.color.secondary_text'))
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(21)
          .fontColor([$r('app.color.faint_text')])
          .accessibilityText(title)
      }
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 68 })
    .padding({ left: 16, right: 16, top: 11, bottom: 11 })
    .borderRadius(0)
    .backgroundColor(Color.Transparent)
    .id(stableId)
    .accessibilityText(title)
    .onClick(action)
  }

  @Builder
  private versionActionRow(): void {
    Button() {
      Row({ space: 15 }) {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(27)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText($r('app.string.about_app'))

        Text($r('app.string.about_app'))
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.primary_text'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)

        Text($r('app.string.app_version_short'))
          .fontSize(15)
          .fontColor($r('app.color.secondary_text'))

        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(21)
          .fontColor([$r('app.color.faint_text')])
          .accessibilityText($r('app.string.about_app'))
      }
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 60 })
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .borderRadius(0)
    .backgroundColor(Color.Transparent)
    .id('aurora-settings-about')
    .accessibilityText($r('app.string.about_app'))
    .onClick(() => this.onOpenAbout())
  }

  @Builder
  private divider(): void {
    Divider()
      .strokeWidth(1)
      .color($r('app.color.divider'))
      .margin({ left: 60 })
  }

  build() {
    Column() {
      this.titleBar()

      Scroll() {
        Column() {
          Column({ space: 18 }) {
            this.auroraStatusCard()

            Column({ space: 8 }) {
              this.sectionTitle($r('app.string.conversation_section'))
              Column() {
                this.actionRow(
                  $r('sys.symbol.arrow_clockwise'),
                  $r('app.string.reload_chat'),
                  'aurora-settings-reload',
                  () => this.onReload()
                )
                this.divider()
                this.actionRow(
                  $r('sys.symbol.website'),
                  $r('app.string.open_in_browser'),
                  'aurora-settings-browser',
                  () => this.onOpenBrowser()
                )
              }
              .width('100%')
              .borderRadius(22)
              .backgroundColor($r('app.color.surface_background'))
              .border({ width: 1, color: $r('app.color.divider') })
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')

            Column({ space: 8 }) {
              this.sectionTitle($r('app.string.harmony_section'))
              Column() {
                this.detailActionRow(
                  $r('sys.symbol.share'),
                  $r('app.string.system_share'),
                  $r('app.string.system_share_hint'),
                  'aurora-settings-system-share',
                  () => this.onSystemShare()
                )
              }
              .width('100%')
              .borderRadius(22)
              .backgroundColor($r('app.color.surface_background'))
              .border({ width: 1, color: $r('app.color.divider') })
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')

            Column({ space: 8 }) {
              this.sectionTitle($r('app.string.privacy_section'))
              Column() {
                this.actionRow(
                  $r('sys.symbol.checkmark_shield'),
                  $r('app.string.session_and_privacy'),
                  'aurora-settings-privacy',
                  () => this.onOpenPrivacy()
                )
              }
              .width('100%')
              .borderRadius(22)
              .backgroundColor($r('app.color.surface_background'))
              .border({ width: 1, color: $r('app.color.divider') })
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')

            Column({ space: 8 }) {
              this.sectionTitle($r('app.string.about_section'))
              Column() {
                this.versionActionRow()
              }
              .width('100%')
              .borderRadius(22)
              .backgroundColor($r('app.color.surface_background'))
              .border({ width: 1, color: $r('app.color.divider') })
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .constraintSize({ maxWidth: 720 })
        }
        .alignItems(HorizontalAlign.Center)
        .width('100%')
        .padding({ left: 20, right: 20, top: 8, bottom: 32 })
      }
      .width('100%')
      .layoutWeight(1)
      .id('aurora-settings-scroll')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .id('aurora-settings-screen')
    .backgroundColor($r('app.color.page_background'))
  }
}
