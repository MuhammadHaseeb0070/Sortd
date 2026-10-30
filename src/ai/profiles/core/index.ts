import { AIProfileModule } from '../../types';
import { CORE_PROFILE_PROMPT } from './prompt';
import { CORE_TOOLS } from './tools';

export const coreProfile: AIProfileModule = {
  id: 'core',
  name: 'Core Operator',
  shortBadge: 'CORE',
  badgeColor: '#10b981', // emerald
  description:
    'Primary spreadsheet orchestrator equipped with vectorized inspection, batch writes, formula verification, styling, and structural tooling.',
  systemPromptFragment: CORE_PROFILE_PROMPT,
  tools: CORE_TOOLS,
};

export default coreProfile;
