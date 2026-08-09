import { common } from '@kit.AbilityKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { systemShare } from '@kit.ShareKit';
import { createAuroraShareRecord } from '../common/AuroraSharePolicy';

export class SystemShareService {
  static async showAurora(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const record = createAuroraShareRecord();
      const sharedData: systemShare.SharedData = new systemShare.SharedData({
        utd: utd.UniformDataType.HYPERLINK,
        content: record.content,
        title: record.title,
        description: record.description
      });
      const controller: systemShare.ShareController = new systemShare.ShareController(sharedData);
      await controller.show(context, {
        selectionMode: systemShare.SelectionMode.SINGLE,
        previewMode: systemShare.SharePreviewMode.DEFAULT
      });
      return true;
    } catch (_) {
      return false;
    }
  }
}
