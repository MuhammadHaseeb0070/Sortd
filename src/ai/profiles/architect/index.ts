import { AIProfileModule } from '../../types';
import { ARCHITECT_TOOLS } from './tools';
import { ARCHITECT_SYSTEM_PROMPT } from './prompt';

export const architectProfile: AIProfileModule = {
  id: 'architect',
  name: 'Grid Architect',
  shortBadge: 'GRID',
  badgeColor: '#10b981', // Emerald accent (zero purple)
  description:
    'Executive presentation and layout specialist: curated corporate themes, alternating zebra striping, semantic number masks ($ / %), KPI scorecards, and complete dashboard scaffolding.',
  systemPromptFragment: ARCHITECT_SYSTEM_PROMPT,
  tools: ARCHITECT_TOOLS,
};

export default architectProfile;
