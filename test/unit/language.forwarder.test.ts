import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { LanguageForwarder } from '../../src/diff/language.forwarder';
import type { ChangedFile } from '../../src/diff/diff.model';
import { commands, languages, workspace } from '../mocks/vscode';

const committed: ChangedFile = {
  uri: '/workspace/src/use.ts',
  relativePath: 'src/use.ts',
  status: 'modified',
  oldPath: undefined,
  source: { id: 'branch:main...feature', label: 'Committed', description: 'main...feature', baseRef: 'base', targetRef: 'HEAD' },
};
const gitUri = { scheme: 'git', toString: () => 'git:/workspace/src/use.ts?HEAD' } as unknown as vscode.Uri;
const gitDocument = textDocument(gitUri, 'import { Invoice } from "./model";\nconst a: Invoice = x;\n');
const position = { line: 1, character: 10 } as vscode.Position;
const token = {} as vscode.CancellationToken;

const typeInfo = { value: '```ts\ninterface Invoice\n```' };
const blame = { value: 'Committed by someone' };

let hoverProvider: vscode.HoverProvider;
let definitionProvider: vscode.DefinitionProvider;
let forwarder: LanguageForwarder;

beforeEach(() => {
  vi.spyOn(languages, 'registerHoverProvider').mockImplementation((_selector, provider) => {
    hoverProvider = provider as vscode.HoverProvider;
    return { dispose: () => {} };
  });
  vi.spyOn(languages, 'registerDefinitionProvider').mockImplementation((_selector, provider) => {
    definitionProvider = provider as vscode.DefinitionProvider;
    return { dispose: () => {} };
  });
  forwarder = new LanguageForwarder(uri => uri === gitUri ? committed : undefined);
});

afterEach(() => {
  forwarder.dispose();
  vi.restoreAllMocks();
});

describe('LanguageForwarder hovers', () => {
  it('answers from the workspace file while it reads like the committed version', async () => {
    onDisk(gitDocument.getText().replace(/\n/g, '\r\n'));
    const editor = fakeEditor({ workspaceHovers: [{ contents: [typeInfo], range: 'range' }] });

    const hover = await hoverProvider.provideHover(gitDocument, position, token);

    expect(hover).toMatchObject({ contents: [typeInfo], range: 'range' });
    expect(editor).toHaveBeenCalledWith('vscode.executeHoverProvider', expect.objectContaining({ fsPath: committed.uri }), position);
  });

  it('stays out once the workspace file no longer reads like the committed version', async () => {
    onDisk('const a: Invoice = x; // edited locally\n');
    const editor = fakeEditor({ workspaceHovers: [{ contents: [typeInfo] }] });

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
    expect(editor).not.toHaveBeenCalled();
  });

  it('only answers for documents the Review Desk shows', async () => {
    const openTextDocument = vi.spyOn(workspace, 'openTextDocument');
    const other = textDocument({ toString: () => 'git:/elsewhere.ts' } as unknown as vscode.Uri, '');

    expect(await hoverProvider.provideHover(other, position, token)).toBeUndefined();
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it('leaves files alone that are no longer on disk', async () => {
    vi.spyOn(workspace, 'openTextDocument').mockRejectedValue(new Error('ENOENT'));

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
  });

  it('drops what providers already show on the committed document', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({
      nativeHovers: [{ contents: [blame] }],
      workspaceHovers: [{ contents: [{ ...blame }] }, { contents: [typeInfo] }],
    });

    const hover = await hoverProvider.provideHover(gitDocument, position, token);

    expect(hover?.contents).toEqual([typeInfo]);
  });

  it('adds nothing when the committed document already shows it all', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({ nativeHovers: [{ contents: [blame] }], workspaceHovers: [{ contents: [blame] }] });

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
  });
});

describe('LanguageForwarder definitions', () => {
  it('goes to the definitions the workspace file finds', async () => {
    onDisk(gitDocument.getText());
    const target = { uri: 'model.ts', range: 'range' };
    fakeEditor({ workspaceDefinitions: [target] });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token))
      .toEqual([{ targetUri: 'model.ts', targetRange: 'range' }]);
  });

  it('keeps the committed document own definitions when it has some', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({
      nativeDefinitions: [{ uri: 'git-model.ts', range: 'range' }],
      workspaceDefinitions: [{ uri: 'model.ts', range: 'range' }],
    });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token)).toBeUndefined();
  });
});

function textDocument(uri: vscode.Uri, text: string): vscode.TextDocument {
  return { uri, getText: () => text } as vscode.TextDocument;
}

function onDisk(text: string): void {
  vi.spyOn(workspace, 'openTextDocument').mockImplementation(async uri => textDocument(uri as vscode.Uri, text));
}

interface FakeEditorAnswers {
  readonly nativeHovers?: unknown[];
  readonly workspaceHovers?: unknown[];
  readonly nativeDefinitions?: unknown[];
  readonly workspaceDefinitions?: unknown[];
}

/**
 * Answers the execute commands as VS Code does: a request for the committed
 * document asks every provider for it, the forwarder included.
 */
function fakeEditor(answers: FakeEditorAnswers) {
  let asking = 0;
  return vi.spyOn(commands, 'executeCommand').mockImplementation(async (command, uri, at) => {
    const own = uri === gitUri;
    if (own && asking++) throw new Error('The forwarder forwarded its own request');
    if (command === 'vscode.executeHoverProvider') {
      if (!own) return answers.workspaceHovers ?? [];
      const forwarded = await hoverProvider.provideHover(gitDocument, at as vscode.Position, token);
      return [...answers.nativeHovers ?? [], ...forwarded ? [forwarded] : []];
    }
    if (command === 'vscode.executeDefinitionProvider') {
      if (!own) return answers.workspaceDefinitions ?? [];
      const forwarded = await definitionProvider.provideDefinition(gitDocument, at as vscode.Position, token);
      return [...answers.nativeDefinitions ?? [], ...forwarded ? [forwarded].flat() : []];
    }
    throw new Error(`Unexpected command ${command}`);
  });
}
