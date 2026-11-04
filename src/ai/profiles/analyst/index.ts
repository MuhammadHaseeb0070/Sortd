import { AIProfileModule } from '../../types';
import { ANALYST_TOOLS } from './tools';
import { ANALYST_SYSTEM_PROMPT } from './prompt';

export const analystProfile: AIProfileModule = {
  id: 'analyst',
  name: 'Data Analyst',
  shortBadge: 'STATS',
  badgeColor: '#10b981', // Emerald accent (zero purple)
  description:
    'Business intelligence specialist: multi-dimensional GroupBy rollups, 2D cross-tab pivot tables, MoM/YoY temporal velocity, 80/20 Pareto customer tiering, IQR outlier detection, and what-if sensitivity modeling.',
  systemPromptFragment: ANALYST_SYSTEM_PROMPT,
  tools: ANALYST_TOOLS,
};

export default analystProfile;
