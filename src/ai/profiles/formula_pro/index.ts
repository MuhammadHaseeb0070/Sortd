import { AIProfileModule } from '../../types';
import { FORMULA_PRO_TOOLS } from './tools';
import { FORMULA_PRO_SYSTEM_PROMPT } from './prompt';

export const formulaProProfile: AIProfileModule = {
  id: 'formula_pro',
  name: 'Formula Pro',
  shortBadge: 'CALC',
  badgeColor: '#10b981', // Emerald
  description:
    'Advanced financial modeling, cross-sheet lookups (XLOOKUP / INDEX-MATCH), conditional aggregations (SUMIFS), dynamic arrays, and self-healing formula repair.',
  systemPromptFragment: FORMULA_PRO_SYSTEM_PROMPT,
  tools: FORMULA_PRO_TOOLS,
};

export default formulaProProfile;
