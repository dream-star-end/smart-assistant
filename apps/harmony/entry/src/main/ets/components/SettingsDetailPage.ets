export enum SettingsDetailPageKind {
  PRIVACY = 'privacy',
  ABOUT = 'about'
}

@Component
export struct SettingsDetailPage {
  @Prop pageKind: SettingsDetailPageKind = SettingsDetailPageKind.PRIVACY;

  onBack: () => void = () => {};

  @Builder
  private pageTitle(): void {
    if (this.pageKind === SettingsDetailPageKind.PRIVACY) {
      Text($r('app.string.session_and_privacy'))
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.primary_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: 60, right: 60 })
    } else {
      Text($r('app.string.about_app'))
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.primary_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: 60, right: 60 })
    }
  }

  @Builder
  private titleBar(): void {
    Stack({ alignContent: Alignment.Center }) {
      this.pageTitle()

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
        .id(this.pageKind === SettingsDetailPageKind.PRIVACY ?
          'aurora-privacy-back' : 'aurora-about-back')
        .accessibilityText($r('app.string.back'))
        .onClick(() => this.onBack())

        Blank()
      }
      .width('100%')
    }
    .width('100%')
    .constraintSize({ minHeight: 68 })
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .backgroundColor($r('app.color.page_background'))
  }

  @Builder
  private privacyContent(): void {
    Column({ space: 24 }) {
      SymbolGlyph($r('sys.symbol.checkmark_shield'))
        .fontSize(58)
        .fontColor([$r('app.color.brand_primary')])
        .accessibilityText($r('app.string.session_and_privacy'))

      Column() {
        Row({ space: 16 }) {
          Text($r('app.string.service_domain'))
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.primary_text'))
            .layoutWeight(1)
          Text('claudeai.chat')
            .fontSize(14)
            .fontColor($r('app.color.secondary_text'))
        }
        .width('100%')
        .constraintSize({ minHeight: 62 })
        .padding({ left: 18, right: 18, top: 14, bottom: 14 })

        Divider()
          .strokeWidth(1)
          .color($r('app.color.divider'))
          .margin({ left: 18, right: 18 })

        Text($r('app.string.session_storage_hint'))
          .fontSize(15)
          .fontColor($r('app.color.secondary_text'))
          .width('100%')
          .padding({ left: 18, right: 18, top: 18, bottom: 20 })
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .borderRadius(22)
      .backgroundColor($r('app.color.surface_background'))
      .border({ width: 1, color: $r('app.color.divider') })
    }
    .alignItems(HorizontalAlign.Center)
    .width('100%')
  }

  @Builder
  private aboutContent(): void {
    Column({ space: 18 }) {
      Image($r('app.media.aurora_icon'))
        .width(88)
        .height(88)
        .borderRadius(26)
        .accessibilityText($r('app.string.about_app'))

      Text('Aurora')
        .fontSize(28)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.primary_text'))

      Text($r('app.string.app_version'))
        .fontSize(16)
        .fontColor($r('app.color.secondary_text'))
        .textAlign(TextAlign.Center)

      Text($r('app.string.compatibility_mode'))
        .fontSize(14)
        .fontColor($r('app.color.faint_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: 18, right: 18, top: 18, bottom: 18 })
        .borderRadius(18)
        .backgroundColor($r('app.color.surface_background'))
        .border({ width: 1, color: $r('app.color.divider') })
    }
    .alignItems(HorizontalAlign.Center)
    .width('100%')
  }

  build() {
    Column() {
      this.titleBar()

      Scroll() {
        Column() {
          Column() {
            if (this.pageKind === SettingsDetailPageKind.PRIVACY) {
              this.privacyContent()
            } else {
              this.aboutContent()
            }
          }
          .width('100%')
          .constraintSize({ maxWidth: 720 })
        }
        .alignItems(HorizontalAlign.Center)
        .width('100%')
        .padding({ left: 20, right: 20, top: 24, bottom: 40 })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .id(this.pageKind === SettingsDetailPageKind.PRIVACY ?
      'aurora-privacy-screen' : 'aurora-about-screen')
    .backgroundColor($r('app.color.page_background'))
  }
}
