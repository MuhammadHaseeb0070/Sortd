import { AIProfileModule } from '../../types';
import { AUDITOR_TOOLS } from './tools';
import { AUDITOR_SYSTEM_PROMPT } from './prompt';

export const auditorProfile: AIProfileModule = {
  id: 'auditor',
  name: 'Sheet Auditor',
  shortBadge: 'AUDIT',
  badgeColor: '#ef4444', // red
  description:
    'Institutional-grade spreadsheet auditor for formula integrity (#REF!, #DIV/0!), dependency tracing, double-entry cross-footing, continuity omissions, and forensic Benford fraud checks.',
  systemPromptFragment: AUDITOR_SYSTEM_PROMPT,
  tools: AUDITOR_TOOLS,
};

export default auditorProfile;
