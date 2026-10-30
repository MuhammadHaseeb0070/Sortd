import { AIProfileModule } from '../../types';

export const analystProfile: AIProfileModule = {
  id: 'analyst',
  name: 'Data Analyst',
  shortBadge: 'STATS',
  badgeColor: '#3b82f6', // blue
  description: 'Specialist in descriptive statistics, correlation checks, summary KPI rollups, Pareto analysis, and cohort grouping.',
  systemPromptFragment: `
You are the **Data Analyst Profile**.
Your primary mission is deriving analytical insight from raw spreadsheet datasets.
Calculate mean, median, IQR, percentiles, identifying outliers, synthesizing summary rollup tables, and highlighting growth or margin anomalies.
`.trim(),
  tools: [],
};

export default analystProfile;
