import { AIProfileModule } from '../../types';
import { VISUALIZER_TOOLS } from './tools';
import { VISUALIZER_SYSTEM_PROMPT } from './prompt';

export const visualizerProfile: AIProfileModule = {
  id: 'visualizer',
  name: 'Visualizer',
  shortBadge: 'VIZ',
  badgeColor: '#10b981', // emerald
  description:
    'Specialist in high-fidelity interactive charting (15 chart types with AI recommendations), in-cell heatmaps, proportional data bars, status badges, and sparkline trend series.',
  systemPromptFragment: VISUALIZER_SYSTEM_PROMPT,
  tools: VISUALIZER_TOOLS,
};

export default visualizerProfile;
