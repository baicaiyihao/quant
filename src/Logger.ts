/**
 * 简单的日志工具类
 */

import { marked } from 'marked';
const { markedTerminal } = require('marked-terminal');
marked.use(markedTerminal());

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LoggerConfig {
  level?: LogLevel;
  prefix?: string;
  enableColors?: boolean;
}

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private enableColors: boolean;

  constructor(prefix: string = '', config: LoggerConfig = {}) {
    this.prefix = prefix;
    this.level = config.level ?? LogLevel.INFO;
    this.enableColors = config.enableColors ?? true;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const prefixStr = this.prefix ? `[${this.prefix}] ` : '';
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    return `${timestamp} ${level} ${prefixStr}${message}${dataStr}`;
  }

  private colorize(text: string, color: string): string {
    if (!this.enableColors) return text;
    
    const colors: Record<string, string> = {
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      green: '\x1b[32m',
      reset: '\x1b[0m',
    };
    
    return `${colors[color] || ''}${text}${colors.reset}`;
  }

  debug(message: string, data?: any): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(this.colorize(this.formatMessage('[DEBUG]', message, data), 'blue'));
    }
  }

  info(message: string, data?: any): void {
    if (this.level <= LogLevel.INFO) {
      console.log(this.colorize(this.formatMessage('[INFO]', message, data), 'green'));
    }
  }

  warn(message: string, data?: any): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.colorize(this.formatMessage('[WARN]', message, data), 'yellow'));
    }
  }

  error(message: string, data?: any): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.colorize(this.formatMessage('[ERROR]', message, data), 'red'));
    }
  }

  /**
   * 渲染markdown内容
   */
  renderMarkdown(markdown: string): void {
    try {
      console.log(marked.parse(markdown));
    } catch (error) {
      console.error('Markdown渲染失败:', error);
      console.log(markdown);
    }
  }

  /**
   * 渲染表格
   */
  renderTable(headers: string[], rows: string[][]): void {
    const markdownTable = this.buildMarkdownTable(headers, rows);
    this.renderMarkdown(markdownTable);
  }

  /**
   * 渲染标题
   */
  renderHeading(level: number, text: string): void {
    const heading = '#'.repeat(level) + ' ' + text;
    this.renderMarkdown(heading);
  }

  /**
   * 渲染列表
   */
  renderList(items: string[], ordered: boolean = false): void {
    const list = items.map((item, index) => {
      if (ordered) {
        return `${index + 1}. ${item}`;
      } else {
        return `- ${item}`;
      }
    }).join('\n');
    
    this.renderMarkdown(list);
  }

  /**
   * 渲染代码块
   */
  renderCode(code: string, language: string = ''): void {
    const codeBlock = `\`\`\`${language}\n${code}\n\`\`\``;
    this.renderMarkdown(codeBlock);
  }

  /**
   * 渲染引用
   */
  renderQuote(text: string): void {
    const quote = `> ${text}`;
    this.renderMarkdown(quote);
  }

  /**
   * 构建markdown表格字符串
   */
  private buildMarkdownTable(headers: string[], rows: string[][]): string {
    let table = '| ' + headers.join(' | ') + ' |\n';
    table += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
    
    for (const row of rows) {
      table += '| ' + row.join(' | ') + ' |\n';
    }
    
    return table;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }
}

/**
 * 创建默认logger实例
 */
export function createLogger(prefix: string, config?: LoggerConfig): Logger {
  return new Logger(prefix, config);
}

export const logger = createLogger('BlueQuant');