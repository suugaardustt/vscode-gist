import { window, workspace, commands, Memento, TextDocument } from 'vscode';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as path from 'path';
import open = require('open');
import { StorageBlock, StorageService } from './services/storage.service';

export class Commands {

  private _provider: StorageService;

  constructor(private _codeFileServices: { [provider: string]: StorageService; }, private _store: Memento) {
    this._init();
  }

  /**
   * User selects code block from quick pick menu, files open
   */
  async openCodeBlock(favorite = false) {
    try {
      // codeBlock is selected by user
      const codeBlock = await this._selectCodeBlock(favorite);
      if (!codeBlock) {
        return;
      }
      const directory = this._createTmpDir(codeBlock.id);

      // Is there an active text editor?
      if (window.activeTextEditor) {
        // Close it
        await commands.executeCommand('workbench.action.closeOtherEditors');
      }

      // Open an editor for each file in CodeFile
      let i = 0;
      for(let fileName in codeBlock.files) {
        i++;
        let file = codeBlock.files[fileName];
        if (i > 1) {
          await commands.executeCommand('workbench.action.focusFirstEditorGroup');
          await commands.executeCommand('workbench.action.splitEditor');
        }
        await this._openTextDocument(directory, fileName, file.content);
      }
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * User creates a code block from open file or selected text
   * Resulting code block is opened in browser
   */
  async createCodeBlock() {
    try {
      const editor = window.activeTextEditor;
      if (!editor) {
        throw new Error('Open a file before creating');
      }
      let selection = editor.selection;
      let text = editor.document.getText(selection.isEmpty ? undefined : selection);
      let fileName = this._getFileNameFromPath(editor.document.fileName) || 'untitled.txt';
      let description = await this._prompt('Enter description');
      let isPrivate = (await this._prompt('Private? Y = Yes, N = No')).substr(0, 1).toLowerCase() === 'y';
      let storageBlock = await this._provider.createFile(fileName, description, text, isPrivate);
      open(storageBlock.html_url); // launch user's default browser
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * Opens current code block in browser
   */
  async openCodeBlockInBrowser() {
    try {
      const details = this._getCurrentDocument();
      
      const storageBlock = await this._provider.getStorageBlockById(details.storageBlockId);

      open(storageBlock.html_url); // launch user's default browser
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * Deletes current code block and closes all associated editors
   */
  async deleteCodeBlock() {
    try {

      const details = this._getCurrentDocument();
      
      await this._provider.deleteStorageBlock(details.storageBlockId);

      const editors = window.visibleTextEditors;

      // close editors associated to this StorageBlock
      for (let e of editors) {
        let d = this._getCodeFileDetails(e.document);
        if (d && d.storageBlockId === details.storageBlockId) {
          commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }

      this._notify('Block Deleted');
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * Removes file from code block
   */
  async removeFileFromCodeBlock() {
    try {
      const details = this._getCurrentDocument();

      await this._provider.removeFileFromStorageBlock(details.storageBlockId, details.fileName);

      commands.executeCommand('workbench.action.closeActiveEditor');

      this._notify('File Removed From Block');
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * Add a file or selection to existing code block
   * If file already exists we generate new file name (might need to come back to this)
   */
  async addToCodeBlock() {
    try {
      const editor = window.activeTextEditor;
      if (!editor) {
        throw new Error('Open a file before adding');
      }
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      let fileName = this._getFileNameFromPath(editor.document.fileName) || 'untitled.txt';
      const codeBlock = await this._selectCodeBlock();
      if (!codeBlock) {
        return;
      }
      // check if fileName exists prior to adding new file.
      let i = 1;
      let originalFileName = fileName;
      while (codeBlock.files.hasOwnProperty(fileName)) {
        let extPos = originalFileName.lastIndexOf('.');
        if (extPos === -1) {
          extPos = originalFileName.length;
        }
        let ext = originalFileName.substr(extPos);
        fileName = originalFileName.substring(0, extPos) + i + ext;
        i++;
      }
      await this._provider.editFile(codeBlock.id, fileName, text);
      this._notify('File Added To Block');
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * Change code block description
   */
  async changeCodeBlockDescription() {
    try {
      const details = this._getCurrentDocument();
      const codeBlock = await this._provider.getStorageBlockById(details.storageBlockId);
      const description = await this._prompt('Enter Description', codeBlock.description);
      if (!description) {
        return;
      }
      await this._provider.changeDescription(details.storageBlockId, description);
      this._notify('Block Description Saved');
    } catch (error) {
      this._showError(error);
    }
  }

  /**
   * User saves a text document
   * @param doc
   */
  async onSaveTextDocument(doc: TextDocument) {
    const {storageBlockId, fileName} = this._getCodeFileDetails(doc);
    try {
      if (storageBlockId) {
        await this._provider.editFile(storageBlockId, fileName, doc.getText());
        await this._notify('File Saved To Block');
      }
    } catch (error) {
      this._showError(error);
    }
  }

  private _getCurrentDocument() {
      const doc = (window.activeTextEditor) ? window.activeTextEditor.document : undefined;

      if (!doc) {
        throw new Error('No open documents');
      }

      const details = this._getCodeFileDetails(doc);

      if (!details) {
        throw new Error(`Not a code block in ${this._provider.name}`);
      }

      return details;
  }

  private _getCodeFileDetails(doc: TextDocument) {
    let sep = (path.sep === '\\') ? '\\\\' : path.sep;
    let regexp = new RegExp(`.*vscode_gist_([^_]*)_[^${sep}]*${sep}(.*)`);
    let matches = doc.fileName.match(regexp);
    if (matches) {
      return {
        path: path.dirname(matches[0]),
        storageBlockId: matches[1],
        fileName: matches[2],
      };
    }
  }

  private async _selectCodeBlock(favorite = false) {
    await this._loginUser();
    const files: StorageBlock[] = await this._provider.list(favorite);
    const selectedFile = await window.showQuickPick<StorageBlock>(files);
    if (selectedFile) {
      return this._provider.getStorageBlock(selectedFile.url);
    }
  }

  private _createTmpDir(key: string, options = { prefix: 'vscode_gist_' }): string {
      const prefix = options.prefix + key + '_';
      const directory = tmp.dirSync({ prefix });
      return directory.name;
  }
  
  private async _openTextDocument(dir, filename, content) {
    let file = path.join(dir, filename);
    fs.writeFileSync(file, content);
    return workspace.openTextDocument(file)
      .then((doc: TextDocument) => window.showTextDocument(doc));
  }
  
  private async _loginUser() {
    const providerName = this._provider.name;
    if (this._provider.isAuthenticated()) {
      return Promise.resolve();
    }
    const username: string = (await window.showInputBox({
      prompt: `Enter your ${providerName} username`
    })).trim();
    const password: string = (await window.showInputBox({
      prompt: `Enter your ${providerName} password.`
    })).trim();
    await this._provider.login(username, password);
  }

  private _showError(error: any) {
      let msg: string;
      if (typeof error === 'string') {
        msg = error;
      } else if (error && error.message) {
        msg = error.message;
      } else {
        msg = 'An unknown error occurred';
      }
      
      console.error(error);

      // Prefix message w/ 'GIST ERROR:' so the user knows
      // where the error is coming from.
      window.showErrorMessage(`GIST ERROR: ${msg} [${this._provider.name}]`);
  }

  private _prompt(message: string, value?: string) {
    return window.showInputBox({ prompt: message, value });
  }

  private _notify(message: string) {
    return window.showInformationMessage(`GIST MESSAGE: ${message} [${this._provider.name}]`);
  }

  private _getFileNameFromPath(filePath: string) {
    return path.basename(filePath);
  }

  private async _setProvider(providerKey: string) {
    await this._store.update('providerKey', providerKey);
    this._provider = this._codeFileServices[providerKey];
  }

  private async _init() {
    const providerKey = await this._store.get<string>('providerKey');

    if (providerKey) {
      return this._setProvider(providerKey);
    } else if (Object.keys(this._codeFileServices).length === 1) {
      return this._setProvider(Object.keys(this._codeFileServices)[0]);
    }
  }
}