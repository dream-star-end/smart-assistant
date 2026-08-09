@Component
export struct WorkbenchHome {
  @Prop online: boolean = true;

  onEnterConversation: () => void = () => {};
  onOpenSettings: () => void = () => {};
  onSystemShare: () => void = () => {};

  @Builder
  private connectionStatus(): void {
    Row({ space: 7 }) {
      Circle()
        .width(8)
        .height(8)
        .fill(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
        .accessibilityText(this.online ? $r('app.string.connected') : $r('app.string.offline'))

      Text(this.online ? $r('app.string.connected') : $r('app.string.offline'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.online ? $r('app.color.connected') : $r('app.color.offline_text'))
    }
  }

  @Builder
  private header(): void {
    Row({ space: 14 }) {
      Image($r('app.media.aurora_icon'))
        .width(52)
        .height(52)
        .borderRadius(15)
        .accessibilityText($r('app.string.home_title'))

      Column({ space: 5 }) {
        Text('Aurora')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.primary_text'))
        this.connectionStatus()
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Button() {
        SymbolGlyph($r('sys.symbol.gearshape'))
          .fontSize(25)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText($r('app.string.settings'))
      }
      .type(ButtonType.Normal)
      .width(52)
      .height(52)
      .padding(0)
      .borderRadius(18)
      .backgroundColor($r('app.color.surface_background'))
      .id('aurora-open-settings')
      .accessibilityText($r('app.string.open_settings'))
      .onClick(() => this.onOpenSettings())
    }
    .width('100%')
    .constraintSize({ minHeight: 68 })
  }

  @Builder
  private primaryAction(): void {
    Button() {
      Row({ space: 10 }) {
        SymbolGlyph($r('sys.symbol.message'))
          .fontSize(23)
          .fontColor([Color.White])
          .accessibilityText($r('app.string.enter_conversation'))
        Text($r('app.string.enter_conversation'))
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(Color.White)
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 56 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .borderRadius(18)
    .backgroundColor($r('app.color.brand_primary'))
    .id('aurora-enter-conversation')
    .accessibilityText($r('app.string.enter_conversation'))
    .onClick(() => this.onEnterConversation())
  }

  @Builder
  private shareAction(): void {
    Button() {
      Row({ space: 10 }) {
        SymbolGlyph($r('sys.symbol.share'))
          .fontSize(22)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText($r('app.string.system_share'))
        Text($r('app.string.system_share'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.primary_text'))
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')
    }
    .type(ButtonType.Normal)
    .width('100%')
    .constraintSize({ minHeight: 54 })
    .padding({ left: 18, right: 18, top: 11, bottom: 11 })
    .borderRadius(18)
    .backgroundColor($r('app.color.surface_background'))
    .id('aurora-home-system-share')
    .accessibilityText($r('app.string.system_share'))
    .onClick(() => this.onSystemShare())
  }

  @Builder
  private capabilityRow(icon: Resource, title: Resource, hint: Resource): void {
    Row({ space: 15 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(icon)
          .fontSize(25)
          .fontColor([$r('app.color.brand_primary')])
          .accessibilityText(title)
      }
      .width(44)
      .height(44)
      .borderRadius(14)
      .backgroundColor($r('app.color.auth_bar_background'))

      Column({ space: 4 }) {
        Text(title)
          .fontSize(16)
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
    }
    .width('100%')
    .constraintSize({ minHeight: 76 })
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
  }

  build() {
    Scroll() {
      Column() {
        Column({ space: 28 }) {
          this.header()

          Column({ space: 12 }) {
            Text($r('app.string.home_title'))
              .fontSize(30)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.primary_text'))
              .width('100%')
            Text($r('app.string.home_summary'))
              .fontSize(16)
              .fontColor($r('app.color.secondary_text'))
              .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')

          Column({ space: 12 }) {
            this.primaryAction()
            this.shareAction()
          }
          .width('100%')

          Column({ space: 12 }) {
            Text($r('app.string.home_harmony_features'))
              .fontSize(18)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.secondary_text'))
              .width('100%')

            Column() {
              this.capabilityRow(
                $r('sys.symbol.folder'),
                $r('app.string.system_file_picker'),
                $r('app.string.system_file_picker_hint')
              )
              Divider()
                .strokeWidth(1)
                .color($r('app.color.divider'))
                .margin({ left: 75 })
              this.capabilityRow(
                $r('sys.symbol.mic_fill'),
                $r('app.string.voice_input'),
                $r('app.string.voice_input_hint')
              )
              Divider()
                .strokeWidth(1)
                .color($r('app.color.divider'))
                .margin({ left: 75 })
              this.capabilityRow(
                $r('sys.symbol.checkmark_shield'),
                $r('app.string.safe_session'),
                $r('app.string.safe_session_hint')
              )
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
      .padding({ left: 20, right: 20, top: 24, bottom: 40 })
    }
    .width('100%')
    .height('100%')
    .id('aurora-workbench-screen')
    .scrollBar(BarState.Off)
    .backgroundColor($r('app.color.page_background'))
  }
}
