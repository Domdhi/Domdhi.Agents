// Must never run in adopter application gates, even after agent-file edits.
require('node:fs').writeFileSync('AGENT_SUITE_RAN', 'incorrect gate ownership');
throw new Error('Toolkit tests belong in Domdhi.Agents only');
