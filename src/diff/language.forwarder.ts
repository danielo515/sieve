import * as vscode from 'vscode';
import type { ChangedFile } from './diff.model';

/** The Review Desk file a document shows, if any. */
export type FileLookup = (uri: vscode.Uri) => ChangedFile | undefined;

/**
 * Gives committed diffs hovers and go to definition.
 *
 * Sieve shows committed versions as `git:` documents, which most language servers
 * skip (VS Code's TypeScript extension disables the scheme outright). While a
 * committed version reads exactly like the file in the workspace, that file's
 * answers hold for it too, so requests are forwarded there.
 */
export class LanguageForwarder implements vscode.Disposable {
  /**
   * Requests this forwarder is putting to the other providers, so it can sit them
   * out. Keyed by document and position: providers get no other context.
   */
  private readonly _probing = new Set<string>();
  private readonly _registrations: vscode.Disposable[];

  constructor(private readonly _findFile: FileLookup) {
    const selector: vscode.DocumentSelector = { scheme: 'git' };
    this._registrations = [
      vscode.languages.registerHoverProvider(selector, {
        provideHover: (document, position) => this._hover(document, position),
      }),
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (document, position) => this._definition(document, position),
      }),
    ];
  }

  dispose(): void {
    for (const registration of this._registrations) registration.dispose();
  }

  private async _hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const key = requestKey('hover', document, position);
    if (this._probing.has(key)) return undefined;
    const twin = await this._workspaceTwin(document);
    if (!twin) return undefined;

    const [native, forwarded] = await Promise.all([
      this._probe(key, () => executeHovers(document.uri, position)),
      executeHovers(twin, position),
    ]);
    // Providers that already serve `git:` documents (JSON, CSS, …) would answer twice.
    const shown = new Set(native.flatMap(hover => hover.contents.map(markdownText)));
    const contents = forwarded
      .flatMap(hover => hover.contents)
      .filter(content => !shown.has(markdownText(content)));
    if (!contents.length) return undefined;
    return new vscode.Hover(contents, forwarded.find(hover => hover.range)?.range);
  }

  private async _definition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[] | undefined> {
    const key = requestKey('definition', document, position);
    if (this._probing.has(key)) return undefined;
    const twin = await this._workspaceTwin(document);
    if (!twin) return undefined;

    const [native, forwarded] = await Promise.all([
      this._probe(key, () => executeDefinitions(document.uri, position)),
      executeDefinitions(twin, position),
    ]);
    // Native answers point into the `git:` document and forwarded ones into the
    // workspace, so they never match up; when the document has its own, keep those.
    return native.length ? undefined : forwarded.map(toLocationLink);
  }

  /** The workspace file this committed document reads exactly like, if any. */
  private async _workspaceTwin(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
    const file = this._findFile(document.uri);
    if (!file) return undefined;
    const twin = vscode.Uri.file(file.uri);
    try {
      return sameText(document, await vscode.workspace.openTextDocument(twin)) ? twin : undefined;
    } catch {
      // Not on disk: deleted since, outside a sparse checkout, or not a text file.
      return undefined;
    }
  }

  private async _probe<T>(key: string, request: () => Thenable<T>): Promise<T> {
    this._probing.add(key);
    try {
      return await request();
    } finally {
      this._probing.delete(key);
    }
  }
}

function requestKey(kind: string, document: vscode.TextDocument, position: vscode.Position): string {
  return `${kind} ${document.uri.toString()} ${position.line}:${position.character}`;
}

/** Same lines, whatever the line endings: a CRLF checkout of an LF commit reads the same. */
function sameText(left: vscode.TextDocument, right: vscode.TextDocument): boolean {
  return left.getText().replace(/\r\n/g, '\n') === right.getText().replace(/\r\n/g, '\n');
}

function markdownText(content: vscode.MarkdownString | vscode.MarkedString): string {
  return typeof content === 'string' ? content : content.value;
}

function toLocationLink(target: vscode.Location | vscode.LocationLink): vscode.LocationLink {
  return 'targetUri' in target ? target : { targetUri: target.uri, targetRange: target.range };
}

function executeHovers(uri: vscode.Uri, position: vscode.Position): Thenable<vscode.Hover[]> {
  return vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
}

function executeDefinitions(uri: vscode.Uri, position: vscode.Position): Thenable<(vscode.Location | vscode.LocationLink)[]> {
  return vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', uri, position,
  );
}
