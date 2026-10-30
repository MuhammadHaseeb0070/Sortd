import { AIProfileModule } from '../../types';
import { SANITIZER_TOOLS } from './tools';
import { SANITIZER_SYSTEM_PROMPT } from './prompt';

export const sanitizerProfile: AIProfileModule = {
  id: 'sanitizer',
  name: 'Data Sanitizer',
  shortBadge: 'CLEAN',
  badgeColor: '#059669', // Emerald accent (zero purple)
  description:
    'Advanced data manipulation and ETL specialist: multi-column synthesis, regex text-to-columns, fuzzy deduplication, gap imputation, and table reshaping.',
  systemPromptFragment: SANITIZER_SYSTEM_PROMPT,
  tools: SANITIZER_TOOLS,
};

export default sanitizerProfile;
