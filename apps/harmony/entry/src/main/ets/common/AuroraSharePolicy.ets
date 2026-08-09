export const AURORA_SHARE_URL: string = 'https://claudeai.chat/';

export interface AuroraShareRecord {
  utd: string;
  content: string;
  title: string;
  description: string;
}

export function createAuroraShareRecord(): AuroraShareRecord {
  return {
    utd: 'general.hyperlink',
    content: AURORA_SHARE_URL,
    title: 'Aurora',
    description: '在 Aurora 中继续你的 AI 工作'
  };
}
