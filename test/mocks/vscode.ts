/**
 * Minimal stand-in for the `vscode` module (aliased in vitest.config.ts) so
 * units that need a few editor APIs can be tested in Node.
 */
export class EventEmitter<T> {
  private _listeners: ((event: T) => void)[] = [];

  readonly event = (listener: (event: T) => void): { dispose(): void } => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
  };

  fire(event: T): void {
    for (const listener of [...this._listeners]) listener(event);
  }

  dispose(): void {
    this._listeners = [];
  }
}

export class Disposable {
  constructor(private readonly _onDispose: () => void) {}

  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(disposable => disposable.dispose()));
  }

  dispose(): void {
    this._onDispose();
  }
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
};

export interface WorkspaceFolder {
  readonly uri: { readonly fsPath: string };
  readonly name: string;
}

export const workspaceFoldersChanged = new EventEmitter<void>();

export const workspace: {
  workspaceFolders: WorkspaceFolder[] | undefined;
  onDidChangeWorkspaceFolders: EventEmitter<void>['event'];
  openTextDocument(uri: unknown): Promise<unknown>;
} = {
  workspaceFolders: undefined,
  onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
  openTextDocument: async () => { throw new Error('No document'); },
};

export class Hover {
  constructor(readonly contents: unknown[], readonly range?: unknown) {}
}

/** Tests spy on these to capture providers and answer commands. */
export const languages = {
  registerHoverProvider: (_selector: unknown, _provider: unknown): { dispose(): void } => new Disposable(() => {}),
  registerDefinitionProvider: (_selector: unknown, _provider: unknown): { dispose(): void } => new Disposable(() => {}),
};

export const commands = {
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
};

export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
};
