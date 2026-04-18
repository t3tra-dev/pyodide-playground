export type TerminalStreamType = "stdout" | "stderr";

interface TerminalRenderOptions {
  inputHost?: HTMLElement | null;
}

interface TerminalStyle {
  backgroundColor: string | null;
  bold: boolean;
  dim: boolean;
  foregroundColor: string | null;
  inverse: boolean;
  italic: boolean;
  underline: boolean;
}

interface TerminalCell {
  char: string;
  style: TerminalStyle;
}

const DEFAULT_STYLE: TerminalStyle = {
  backgroundColor: null,
  bold: false,
  dim: false,
  foregroundColor: null,
  inverse: false,
  italic: false,
  underline: false,
};

function cloneStyle(style: TerminalStyle): TerminalStyle {
  return { ...style };
}

function stylesEqual(left: TerminalStyle, right: TerminalStyle) {
  return (
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.foregroundColor === right.foregroundColor &&
    left.inverse === right.inverse &&
    left.italic === right.italic &&
    left.underline === right.underline
  );
}

function xtermColor(index: number) {
  if (index < 0) {
    return null;
  }

  const basicPalette = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];

  if (index < basicPalette.length) {
    return basicPalette[index];
  }

  if (index < 232) {
    const adjusted = index - 16;
    const red = Math.floor(adjusted / 36);
    const green = Math.floor((adjusted % 36) / 6);
    const blue = adjusted % 6;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[red]}, ${levels[green]}, ${levels[blue]})`;
  }

  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function sgrColor(code: number, brightOffset: number) {
  return xtermColor(code + brightOffset);
}

function styleToCss(style: TerminalStyle) {
  const foreground = style.inverse
    ? (style.backgroundColor ?? "var(--terminal-fg)")
    : style.foregroundColor;
  const background = style.inverse
    ? (style.foregroundColor ?? "var(--terminal-bg)")
    : style.backgroundColor;
  const rules: string[] = [];

  if (foreground) {
    rules.push(`color: ${foreground}`);
  }

  if (background) {
    rules.push(`background-color: ${background}`);
  }

  if (style.bold) {
    rules.push("font-weight: 700");
  }

  if (style.dim) {
    rules.push("opacity: 0.7");
  }

  if (style.italic) {
    rules.push("font-style: italic");
  }

  if (style.underline) {
    rules.push("text-decoration: underline");
  }

  return rules.join("; ");
}

function parseParams(raw: string) {
  if (!raw) {
    return [];
  }

  return raw.split(";").map((value) => {
    if (value === "") {
      return 0;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

export class TerminalBuffer {
  private currentStyle: TerminalStyle = cloneStyle(DEFAULT_STYLE);
  private cursorColumn = 0;
  private cursorRow = 0;
  private lines: TerminalCell[][] = [[]];
  private pendingEscape = "";
  private savedCursorColumn = 0;
  private savedCursorRow = 0;

  public write(chunk: string) {
    if (!chunk) {
      return;
    }

    let input = this.pendingEscape + chunk;
    this.pendingEscape = "";
    let index = 0;

    while (index < input.length) {
      const character = input[index];

      if (character === "\x1b") {
        const nextIndex = this.handleEscapeSequence(input, index);
        if (nextIndex === null) {
          this.pendingEscape = input.slice(index);
          break;
        }
        index = nextIndex;
        continue;
      }

      if (character === "\r") {
        this.cursorColumn = 0;
        index += 1;
        continue;
      }

      if (character === "\n") {
        this.cursorRow += 1;
        this.cursorColumn = 0;
        this.ensureLine(this.cursorRow);
        index += 1;
        continue;
      }

      if (character === "\b") {
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
        index += 1;
        continue;
      }

      if (character === "\t") {
        const spaces = 8 - (this.cursorColumn % 8 || 8);
        for (let repeat = 0; repeat < spaces; repeat += 1) {
          this.writeCharacter(" ");
        }
        index += 1;
        continue;
      }

      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) {
        break;
      }

      const text = String.fromCodePoint(codePoint);
      this.writeCharacter(text);
      index += text.length;
    }
  }

  public render(target: HTMLElement, options: TerminalRenderOptions = {}) {
    const fragment = document.createDocumentFragment();
    const inputAnchor = options.inputHost
      ? {
          column: this.cursorColumn,
          host: options.inputHost,
          row: this.cursorRow,
        }
      : null;
    const lines = this.getRenderableLines(Boolean(inputAnchor));

    for (const [lineIndex, line] of lines.entries()) {
      const lineElement = document.createElement("div");
      lineElement.className = "terminal-line";
      const anchorIsOnLine = inputAnchor?.row === lineIndex;
      const appendInputAnchor = (column: number) => {
        if (!inputAnchor || !anchorIsOnLine || inputAnchor.column !== column) {
          return false;
        }

        lineElement.appendChild(inputAnchor.host);
        return true;
      };

      if (line.length === 0) {
        if (appendInputAnchor(0)) {
          fragment.appendChild(lineElement);
          continue;
        }

        lineElement.appendChild(document.createElement("br"));
        fragment.appendChild(lineElement);
        continue;
      }

      let segmentText = "";
      let segmentStyle = line[0].style;

      const flushSegment = () => {
        if (segmentText.length === 0) {
          return;
        }

        const span = document.createElement("span");
        span.textContent = segmentText;

        const css = styleToCss(segmentStyle);
        if (css) {
          span.style.cssText = css;
        }

        lineElement.appendChild(span);
        segmentText = "";
      };

      for (const [column, cell] of line.entries()) {
        if (appendInputAnchor(column)) {
          if (column > line.length) {
            segmentText += " ".repeat(column - line.length);
          }
        }

        if (!stylesEqual(segmentStyle, cell.style)) {
          flushSegment();
          segmentStyle = cell.style;
        }

        segmentText += cell.char;
      }

      flushSegment();
      if (anchorIsOnLine && inputAnchor && inputAnchor.column >= line.length) {
        if (inputAnchor.column > line.length) {
          const spacer = document.createElement("span");
          spacer.textContent = " ".repeat(inputAnchor.column - line.length);
          lineElement.appendChild(spacer);
        }
        appendInputAnchor(inputAnchor.column);
      }
      fragment.appendChild(lineElement);
    }

    target.replaceChildren(fragment);
  }

  private getRenderableLines(keepTrailingLine: boolean) {
    if (
      !keepTrailingLine &&
      this.lines.length > 1 &&
      this.lines[this.lines.length - 1].length === 0
    ) {
      return this.lines.slice(0, -1);
    }

    return this.lines;
  }

  private handleEscapeSequence(input: string, startIndex: number) {
    if (startIndex + 1 >= input.length) {
      return null;
    }

    const introducer = input[startIndex + 1];

    if (introducer === "[") {
      let cursor = startIndex + 2;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
          const params = input.slice(startIndex + 2, cursor);
          this.applyCsi(params, input[cursor]);
          return cursor + 1;
        }
        cursor += 1;
      }
      return null;
    }

    if (introducer === "]") {
      let cursor = startIndex + 2;
      while (cursor < input.length) {
        if (input[cursor] === "\u0007") {
          return cursor + 1;
        }
        if (input[cursor] === "\x1b" && input[cursor + 1] === "\\") {
          return cursor + 2;
        }
        cursor += 1;
      }
      return null;
    }

    return startIndex + 2;
  }

  private applyCsi(rawParams: string, final: string) {
    const params = parseParams(rawParams);
    const getParam = (index: number, fallback: number) => {
      const value = params[index];
      return value && value > 0 ? value : fallback;
    };

    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - getParam(0, 1));
        break;
      case "B":
        this.cursorRow += getParam(0, 1);
        this.ensureLine(this.cursorRow);
        break;
      case "C":
        this.cursorColumn += getParam(0, 1);
        break;
      case "D":
        this.cursorColumn = Math.max(0, this.cursorColumn - getParam(0, 1));
        break;
      case "E":
        this.cursorRow += getParam(0, 1);
        this.cursorColumn = 0;
        this.ensureLine(this.cursorRow);
        break;
      case "F":
        this.cursorRow = Math.max(0, this.cursorRow - getParam(0, 1));
        this.cursorColumn = 0;
        break;
      case "G":
        this.cursorColumn = Math.max(0, getParam(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.cursorRow = Math.max(0, getParam(0, 1) - 1);
        this.cursorColumn = Math.max(0, getParam(1, 1) - 1);
        this.ensureLine(this.cursorRow);
        break;
      case "J":
        this.eraseInDisplay(params[0] ?? 0);
        break;
      case "K":
        this.eraseInLine(params[0] ?? 0);
        break;
      case "m":
        this.applySgr(params);
        break;
      case "s":
        this.savedCursorRow = this.cursorRow;
        this.savedCursorColumn = this.cursorColumn;
        break;
      case "u":
        this.cursorRow = this.savedCursorRow;
        this.cursorColumn = this.savedCursorColumn;
        this.ensureLine(this.cursorRow);
        break;
      default:
        break;
    }
  }

  private applySgr(params: number[]) {
    if (params.length === 0) {
      this.currentStyle = cloneStyle(DEFAULT_STYLE);
      return;
    }

    for (let index = 0; index < params.length; index += 1) {
      const value = params[index];

      switch (value) {
        case 0:
          this.currentStyle = cloneStyle(DEFAULT_STYLE);
          break;
        case 1:
          this.currentStyle.bold = true;
          this.currentStyle.dim = false;
          break;
        case 2:
          this.currentStyle.dim = true;
          this.currentStyle.bold = false;
          break;
        case 3:
          this.currentStyle.italic = true;
          break;
        case 4:
          this.currentStyle.underline = true;
          break;
        case 7:
          this.currentStyle.inverse = true;
          break;
        case 22:
          this.currentStyle.bold = false;
          this.currentStyle.dim = false;
          break;
        case 23:
          this.currentStyle.italic = false;
          break;
        case 24:
          this.currentStyle.underline = false;
          break;
        case 27:
          this.currentStyle.inverse = false;
          break;
        case 39:
          this.currentStyle.foregroundColor = null;
          break;
        case 49:
          this.currentStyle.backgroundColor = null;
          break;
        default:
          if (value >= 30 && value <= 37) {
            this.currentStyle.foregroundColor = sgrColor(value - 30, 0);
          } else if (value >= 40 && value <= 47) {
            this.currentStyle.backgroundColor = sgrColor(value - 40, 0);
          } else if (value >= 90 && value <= 97) {
            this.currentStyle.foregroundColor = sgrColor(value - 90, 8);
          } else if (value >= 100 && value <= 107) {
            this.currentStyle.backgroundColor = sgrColor(value - 100, 8);
          } else if ((value === 38 || value === 48) && params[index + 1] === 5) {
            const paletteIndex = params[index + 2] ?? 0;
            if (value === 38) {
              this.currentStyle.foregroundColor = xtermColor(paletteIndex);
            } else {
              this.currentStyle.backgroundColor = xtermColor(paletteIndex);
            }
            index += 2;
          } else if ((value === 38 || value === 48) && params[index + 1] === 2) {
            const red = params[index + 2] ?? 0;
            const green = params[index + 3] ?? 0;
            const blue = params[index + 4] ?? 0;
            const rgb = `rgb(${red}, ${green}, ${blue})`;
            if (value === 38) {
              this.currentStyle.foregroundColor = rgb;
            } else {
              this.currentStyle.backgroundColor = rgb;
            }
            index += 4;
          }
          break;
      }
    }
  }

  private eraseInDisplay(mode: number) {
    if (mode === 2) {
      this.lines = [[]];
      this.cursorRow = 0;
      this.cursorColumn = 0;
      return;
    }

    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) {
        this.lines[row] = [];
      }
      this.eraseLineSegment(this.cursorRow, 0, this.cursorColumn + 1);
      return;
    }

    this.eraseLineSegment(this.cursorRow, this.cursorColumn);
    for (let row = this.cursorRow + 1; row < this.lines.length; row += 1) {
      this.lines[row] = [];
    }
  }

  private eraseInLine(mode: number) {
    if (mode === 2) {
      this.lines[this.cursorRow] = [];
      return;
    }

    if (mode === 1) {
      this.eraseLineSegment(this.cursorRow, 0, this.cursorColumn + 1);
      return;
    }

    this.eraseLineSegment(this.cursorRow, this.cursorColumn);
  }

  private eraseLineSegment(row: number, from: number, to?: number) {
    const line = this.ensureLine(row);
    const end = to ?? line.length;
    for (let column = from; column < end; column += 1) {
      if (column < line.length) {
        line[column] = {
          char: " ",
          style: cloneStyle(this.currentStyle),
        };
      }
    }
  }

  private ensureLine(row: number) {
    while (this.lines.length <= row) {
      this.lines.push([]);
    }

    return this.lines[row];
  }

  private ensureColumn(line: TerminalCell[], column: number) {
    while (line.length <= column) {
      line.push({
        char: " ",
        style: cloneStyle(DEFAULT_STYLE),
      });
    }
  }

  private writeCharacter(char: string) {
    const line = this.ensureLine(this.cursorRow);
    this.ensureColumn(line, this.cursorColumn);
    line[this.cursorColumn] = {
      char,
      style: cloneStyle(this.currentStyle),
    };
    this.cursorColumn += 1;
  }
}
