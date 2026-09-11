/** Only recognize a leading think block; literal tags later in an answer/code stay text. */
export class ThinkingSplitter {
  private mode: 'prefix' | 'thinking' | 'answer' = 'prefix';
  private pending = '';
  push(text: string): { thinking: boolean; text: string }[] {
    this.pending += text;
    if (this.mode === 'prefix') {
      const prefix = this.pending.trimStart();
      if (this.pending.length <= 128 && '<think>'.startsWith(prefix) && prefix !== '<think>')
        return [];
      if (prefix.startsWith('<think>')) {
        this.mode = 'thinking';
        this.pending = prefix.slice(7);
      } else this.mode = 'answer';
    }
    if (this.mode === 'answer') return this.flush(false);
    const end = this.pending.indexOf('</think>');
    if (end >= 0) {
      const result = [{ thinking: true, text: this.pending.slice(0, end) }];
      this.pending = this.pending.slice(end + 8);
      this.mode = 'answer';
      return [...result, ...this.flush(false)].filter((part) => part.text);
    }
    const safe = Math.max(0, this.pending.length - 7);
    const part = this.pending.slice(0, safe);
    this.pending = this.pending.slice(safe);
    return part ? [{ thinking: true, text: part }] : [];
  }
  finish() {
    return this.flush(this.mode === 'thinking');
  }
  private flush(thinking: boolean) {
    const text = this.pending;
    this.pending = '';
    return text ? [{ thinking, text }] : [];
  }
}
