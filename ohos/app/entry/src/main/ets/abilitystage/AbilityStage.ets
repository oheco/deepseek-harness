import AbilityStage from '@ohos.app.ability.AbilityStage';
import Want from '@ohos.app.ability.Want';
import { windowRegistry } from '../launcher/WindowRegistry';

/** Selects the specified EntryAbility instance, so each window can own an independent connection. */
export default class EntryAbilityStage extends AbilityStage {
  onAcceptWant(want: Want): string {
    return windowRegistry().acceptWant(want);
  }
}
