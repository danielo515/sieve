import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { LanguageForwarder } from '../../src/diff/language.forwarder';
import type { ChangedFile, DiffSource } from '../../src/diff/diff.model';
import type { ReviewFile, ReviewRepository } from '../../src/review/review.repository';
import { commands, languages, workspace } from '../mocks/vscode';

const branchSource: DiffSource = {
  id: 'branch:main...feature', label: 'Committed', description: 'main...feature', baseRef: 'base', targetRef: 'HEAD',
};
const repository = { git: { state: { HEAD: { name: 'feature' } } } } as unknown as ReviewRepository;
const gitUri = { scheme: 'git', fsPath: '/workspace/src/use.ts', toString: () => 'git:/workspace/src/use.ts?HEAD' } as unknown as vscode.Uri;
const gitDocument = textDocument(gitUri, 'import { Invoice } from "./model";\nconst a: Invoice = x;\n');
const position = { line: 1, character: 10 } as vscode.Position;
const token = {} as vscode.CancellationToken;

const typeInfo = { value: '```ts\ninterface Invoice\n```' };
const schemaDocs = { value: 'Enable all strict type checking options.' };

let hoverProvider: vscode.HoverProvider;
let definitionProvider: vscode.DefinitionProvider;
let shown: ReviewFile | undefined;
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
  shown = { repository, file: committedFile(branchSource) };
  forwarder = new LanguageForwarder(uri => uri === gitUri ? shown : undefined);
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
    expect(editor).toHaveBeenCalledWith('vscode.executeHoverProvider', expect.objectContaining({ fsPath: '/workspace/src/use.ts' }), position);
  });

  it('answers for a version committed with CRLF line endings', async () => {
    const crlf = textDocument(gitUri, gitDocument.getText().replace(/\n/g, '\r\n'));
    onDisk(crlf.getText());
    fakeEditor({ workspaceHovers: [{ contents: [typeInfo] }] }, crlf);

    expect(await hoverProvider.provideHover(crlf, position, token)).toMatchObject({ contents: [typeInfo] });
  });

  it('stays out once the workspace file no longer reads like the committed version', async () => {
    onDisk('const a: Invoice = x; // edited locally\n');
    const editor = fakeEditor({ workspaceHovers: [{ contents: [typeInfo] }] });

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
    expect(editor).not.toHaveBeenCalled();
  });

  it('stays out for an edit that keeps the length', async () => {
    onDisk(gitDocument.getText().replace('x;', 'y;'));
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

  it('only answers for the checked-out commit, whose project the workspace shares', async () => {
    onDisk(gitDocument.getText());
    const editor = fakeEditor({ workspaceHovers: [{ contents: [typeInfo] }] });

    shown = { repository, file: committedFile({ ...branchSource, id: 'compare:main...release', targetRef: 'release' }) };
    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
    expect(editor).not.toHaveBeenCalled();

    shown = { repository, file: committedFile({ ...branchSource, id: 'compare:main...feature', targetRef: 'feature' }) };
    expect(await hoverProvider.provideHover(gitDocument, position, token)).toMatchObject({ contents: [typeInfo] });
  });

  it('leaves files alone that are no longer on disk', async () => {
    vi.spyOn(workspace, 'openTextDocument').mockRejectedValue(new Error('ENOENT'));

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
  });

  it('drops what providers already show on the committed document', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({
      nativeHovers: [{ contents: [schemaDocs] }],
      workspaceHovers: [{ contents: [{ ...schemaDocs }], range: 'schema range' }, { contents: [typeInfo], range: 'type range' }],
    });

    const hover = await hoverProvider.provideHover(gitDocument, position, token);

    expect(hover).toMatchObject({ contents: [typeInfo], range: 'type range' });
  });

  it('recognises a hover whose command links name the other document', async () => {
    onDisk(gitDocument.getText());
    const card = (uri: string) => ({ value: `Committed 2 days ago [Open](command:show?${encodeURIComponent(JSON.stringify({ uri }))} "Open") more` });
    fakeEditor({ nativeHovers: [{ contents: [card('git:/use.ts')] }], workspaceHovers: [{ contents: [card('file:///use.ts')] }] });

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
  });

  it('adds nothing when the committed document already shows it all', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({ nativeHovers: [{ contents: [schemaDocs] }], workspaceHovers: [{ contents: [schemaDocs] }] });

    expect(await hoverProvider.provideHover(gitDocument, position, token)).toBeUndefined();
  });
});

describe('LanguageForwarder definitions', () => {
  const model = { scheme: 'file', fsPath: '/workspace/src/model.ts' };

  it('goes to the definitions the workspace file finds', async () => {
    onDisk(gitDocument.getText());
    const link = { originSelectionRange: 'origin', targetUri: model, targetRange: 'range', targetSelectionRange: 'name' };
    fakeEditor({ workspaceDefinitions: [link, { uri: model, range: 'other range' }] });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token)).toEqual([
      link,
      { targetUri: model, targetRange: 'other range' },
    ]);
  });

  it('keeps definitions in the same file inside the committed document', async () => {
    onDisk(gitDocument.getText());
    const local = { scheme: 'file', fsPath: '/workspace/src/use.ts' };
    fakeEditor({ workspaceDefinitions: [{ originSelectionRange: 'origin', targetUri: local, targetRange: 'range' }] });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token)).toEqual([
      { originSelectionRange: 'origin', targetUri: gitUri, targetRange: 'range' },
    ]);
  });

  it('stays out once the workspace file no longer reads like the committed version', async () => {
    onDisk('const a: Invoice = x; // edited locally\n');
    const editor = fakeEditor({ workspaceDefinitions: [{ uri: model, range: 'range' }] });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token)).toBeUndefined();
    expect(editor).not.toHaveBeenCalled();
  });

  it('keeps the committed document own definitions when it has some', async () => {
    onDisk(gitDocument.getText());
    fakeEditor({
      nativeDefinitions: [{ uri: 'git-model.ts', range: 'range' }],
      workspaceDefinitions: [{ uri: model, range: 'range' }],
    });

    expect(await definitionProvider.provideDefinition(gitDocument, position, token)).toBeUndefined();
  });
});

function committedFile(source: DiffSource): ChangedFile {
  return { uri: '/workspace/src/use.ts', relativePath: 'src/use.ts', status: 'modified', oldPath: undefined, source };
}

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
 * document asks every provider for it, the forwarder included, with a fresh
 * position object.
 */
function fakeEditor(answers: FakeEditorAnswers, committed = gitDocument) {
  let asking = 0;
  return vi.spyOn(commands, 'executeCommand').mockImplementation(async (command, uri, at) => {
    const own = uri === gitUri;
    if (own && asking++) throw new Error('The forwarder forwarded its own request');
    const again = { ...at as vscode.Position } as vscode.Position;
    if (command === 'vscode.executeHoverProvider') {
      if (!own) return answers.workspaceHovers ?? [];
      const forwarded = await hoverProvider.provideHover(committed, again, token);
      return [...answers.nativeHovers ?? [], ...forwarded ? [forwarded] : []];
    }
    if (command === 'vscode.executeDefinitionProvider') {
      if (!own) return answers.workspaceDefinitions ?? [];
      const forwarded = await definitionProvider.provideDefinition(committed, again, token);
      return [...answers.nativeDefinitions ?? [], ...forwarded ? [forwarded].flat() : []];
    }
    throw new Error(`Unexpected command ${command}`);
  });
}
