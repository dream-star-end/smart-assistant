import { vibrator } from '@kit.SensorServiceKit';

const TOUCH_EFFECT_ID: string = 'haptic.effect.soft';

export class HapticFeedbackService {
  static async touch(): Promise<void> {
    try {
      const supported: boolean = await vibrator.isSupportEffect(TOUCH_EFFECT_ID);
      if (!supported) {
        return;
      }
      await vibrator.startVibration({
        type: 'preset',
        effectId: TOUCH_EFFECT_ID,
        count: 1,
        intensity: 35
      }, {
        usage: 'touch'
      });
    } catch (_) {
      // Haptics are optional and must never block the requested action.
    }
  }
}
