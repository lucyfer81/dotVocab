// term（英文单词/短语）合法字符集的唯一权威定义：
// 字母、数字、空格和 ' . , ? ! -。
// CSV 导入（csv.ts）与 TTS 合成（tts.ts）共用，防止两端白名单各自漂移
// （曾因此导致 ask...for help 在答题端无法输入、TTS 无法发音）。
export const MAX_TERM_LENGTH = 200;

const TERM_CHAR = /^[A-Za-z0-9 '.?,!-]$/;

// 返回 term 中第一个不合法字符；全部合法则返回 null。
export function findInvalidTermChar(term: string): string | null {
  for (const ch of term) {
    if (!TERM_CHAR.test(ch)) return ch;
  }
  return null;
}

export function isValidTerm(term: string): boolean {
  return term.length <= MAX_TERM_LENGTH && findInvalidTermChar(term) === null;
}
