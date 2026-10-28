<!-- The kit's step-up dialog with the Studio's words; mounted once in the admin layout. -->
<script lang="ts">
import StepUpDialog from '@zveltio/ui/StepUpDialog.svelte';
import { m } from '#lib/i18n.svelte.js';
import { stepUp } from '#lib/step-up.svelte.js';

const labels = $derived({
  title: m['stepUp.title'](),
  intro: m['stepUp.intro'](),
  codeLabel: m['stepUp.codeLabel'](),
  orCodeLabel: m['stepUp.orCodeLabel'](),
  verifyCode: m['stepUp.verifyCode'](),
  usePasskey: m['stepUp.usePasskey'](),
  cancel: m['common.cancel'](),
  close: m['common.close'](),
});
</script>

<StepUpDialog {stepUp} {labels} />
