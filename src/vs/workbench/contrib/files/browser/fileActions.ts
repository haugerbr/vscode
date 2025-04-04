/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { isWindows, OperatingSystem, OS } from 'vs/base/common/platform';
import { extname, basename } from 'vs/base/common/path';
import * as resources from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Action } from 'vs/base/common/actions';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { VIEWLET_ID, IFilesConfiguration, VIEW_ID, UndoConfirmLevel } from 'vs/workbench/contrib/files/common/files';
import { IFileService } from 'vs/platform/files/common/files';
import { EditorResourceAccessor, SideBySideEditor } from 'vs/workbench/common/editor';
import { IQuickInputService, ItemActivation } from 'vs/platform/quickinput/common/quickInput';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ITextModel } from 'vs/editor/common/model';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { REVEAL_IN_EXPLORER_COMMAND_ID, SAVE_ALL_IN_GROUP_COMMAND_ID, NEW_UNTITLED_FILE_COMMAND_ID } from 'vs/workbench/contrib/files/browser/fileConstants';
import { ITextModelService, ITextModelContentProvider } from 'vs/editor/common/services/resolverService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { ILanguageService } from 'vs/editor/common/languages/language';
import { IModelService } from 'vs/editor/common/services/model';
import { ICommandService, CommandsRegistry } from 'vs/platform/commands/common/commands';
import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { Schemas } from 'vs/base/common/network';
import { IDialogService, IConfirmationResult, getFileNamesMessage } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Constants } from 'vs/base/common/uint';
import { CLOSE_EDITORS_AND_GROUP_COMMAND_ID } from 'vs/workbench/browser/parts/editor/editorCommands';
import { coalesce } from 'vs/base/common/arrays';
import { ExplorerItem, NewExplorerItem } from 'vs/workbench/contrib/files/common/explorerModel';
import { getErrorMessage } from 'vs/base/common/errors';
import { triggerUpload } from 'vs/base/browser/dom';
import { IFilesConfigurationService } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { IWorkingCopy } from 'vs/workbench/services/workingCopy/common/workingCopy';
import { timeout } from 'vs/base/common/async';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { Codicon } from 'vs/base/common/codicons';
import { ThemeIcon } from 'vs/base/common/themables';
import { IViewsService, ViewContainerLocation } from 'vs/workbench/common/views';
import { trim, rtrim } from 'vs/base/common/strings';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { ResourceFileEdit } from 'vs/editor/browser/services/bulkEditService';
import { IExplorerService } from 'vs/workbench/contrib/files/browser/files';
import { BrowserFileUpload, FileDownload } from 'vs/workbench/contrib/files/browser/fileImportExport';
import { IPaneCompositePartService } from 'vs/workbench/services/panecomposite/browser/panecomposite';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IPathService } from 'vs/workbench/services/path/common/pathService';
import { Action2 } from 'vs/platform/actions/common/actions';
import { ActiveEditorContext, EmptyWorkspaceSupportContext } from 'vs/workbench/common/contextkeys';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { KeyChord, KeyCode, KeyMod } from 'vs/base/common/keyCodes';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FILE_LABEL = nls.localize('newFile', "New File...");
export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const NEW_FOLDER_LABEL = nls.localize('newFolder', "New Folder...");
export const TRIGGER_RENAME_LABEL = nls.localize('rename', "Rename...");
export const MOVE_FILE_TO_TRASH_LABEL = nls.localize('delete', "Delete");
export const COPY_FILE_LABEL = nls.localize('copyFile', "Copy");
export const PASTE_FILE_LABEL = nls.localize('pasteFile', "Paste");
export const FileCopiedContext = new RawContextKey<boolean>('fileCopied', false);
export const DOWNLOAD_COMMAND_ID = 'explorer.download';
export const DOWNLOAD_LABEL = nls.localize('download', "Download...");
export const UPLOAD_COMMAND_ID = 'explorer.upload';
export const UPLOAD_LABEL = nls.localize('upload', "Upload...");
const CONFIRM_DELETE_SETTING_KEY = 'explorer.confirmDelete';
const MAX_UNDO_FILE_SIZE = 5000000; // 5mb
export const fileCategory = { value: nls.localize('filesCategory', "File"), original: 'File' };

function onError(notificationService: INotificationService, error: any): void {
	if (error.message === 'string') {
		error = error.message;
	}

	notificationService.error(toErrorMessage(error, false));
}

async function refreshIfSeparator(value: string, explorerService: IExplorerService): Promise<void> {
	if (value && ((value.indexOf('/') >= 0) || (value.indexOf('\\') >= 0))) {
		// New input contains separator, multiple resources will get created workaround for #68204
		await explorerService.refresh();
	}
}

async function deleteFiles(explorerService: IExplorerService, workingCopyFileService: IWorkingCopyFileService, dialogService: IDialogService, configurationService: IConfigurationService, elements: ExplorerItem[], useTrash: boolean, skipConfirm = false, ignoreIfNotExists = false): Promise<void> {
	let primaryButton: string;
	if (useTrash) {
		primaryButton = isWindows ? nls.localize('deleteButtonLabelRecycleBin', "&&Move to Recycle Bin") : nls.localize({ key: 'deleteButtonLabelTrash', comment: ['&& denotes a mnemonic'] }, "&&Move to Trash");
	} else {
		primaryButton = nls.localize({ key: 'deleteButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Delete");
	}

	// Handle dirty
	const distinctElements = resources.distinctParents(elements, e => e.resource);
	const dirtyWorkingCopies = new Set<IWorkingCopy>();
	for (const distinctElement of distinctElements) {
		for (const dirtyWorkingCopy of workingCopyFileService.getDirty(distinctElement.resource)) {
			dirtyWorkingCopies.add(dirtyWorkingCopy);
		}
	}
	let confirmed = true;
	if (dirtyWorkingCopies.size) {
		let message: string;
		if (distinctElements.length > 1) {
			message = nls.localize('dirtyMessageFilesDelete', "You are deleting files with unsaved changes. Do you want to continue?");
		} else if (distinctElements[0].isDirectory) {
			if (dirtyWorkingCopies.size === 1) {
				message = nls.localize('dirtyMessageFolderOneDelete', "You are deleting a folder {0} with unsaved changes in 1 file. Do you want to continue?", distinctElements[0].name);
			} else {
				message = nls.localize('dirtyMessageFolderDelete', "You are deleting a folder {0} with unsaved changes in {1} files. Do you want to continue?", distinctElements[0].name, dirtyWorkingCopies.size);
			}
		} else {
			message = nls.localize('dirtyMessageFileDelete', "You are deleting {0} with unsaved changes. Do you want to continue?", distinctElements[0].name);
		}

		const response = await dialogService.confirm({
			type: 'warning',
			message,
			detail: nls.localize('dirtyWarning', "Your changes will be lost if you don't save them."),
			primaryButton
		});

		if (!response.confirmed) {
			confirmed = false;
		} else {
			skipConfirm = true;
		}
	}

	// Check if file is dirty in editor and save it to avoid data loss
	if (!confirmed) {
		return;
	}

	let confirmation: IConfirmationResult;
	// We do not support undo of folders, so in that case the delete action is irreversible
	const deleteDetail = distinctElements.some(e => e.isDirectory) ? nls.localize('irreversible', "This action is irreversible!") :
		distinctElements.length > 1 ? nls.localize('restorePlural', "You can restore these files using the Undo command") : nls.localize('restore', "You can restore this file using the Undo command");

	// Check if we need to ask for confirmation at all
	if (skipConfirm || (useTrash && configurationService.getValue<boolean>(CONFIRM_DELETE_SETTING_KEY) === false)) {
		confirmation = { confirmed: true };
	}

	// Confirm for moving to trash
	else if (useTrash) {
		let { message, detail } = getMoveToTrashMessage(distinctElements);
		detail += detail ? '\n' : '';
		if (isWindows) {
			detail += distinctElements.length > 1 ? nls.localize('undoBinFiles', "You can restore these files from the Recycle Bin.") : nls.localize('undoBin', "You can restore this file from the Recycle Bin.");
		} else {
			detail += distinctElements.length > 1 ? nls.localize('undoTrashFiles', "You can restore these files from the Trash.") : nls.localize('undoTrash', "You can restore this file from the Trash.");
		}

		confirmation = await dialogService.confirm({
			message,
			detail,
			primaryButton,
			checkbox: {
				label: nls.localize('doNotAskAgain', "Do not ask me again")
			}
		});
	}

	// Confirm for deleting permanently
	else {
		let { message, detail } = getDeleteMessage(distinctElements);
		detail += detail ? '\n' : '';
		detail += deleteDetail;
		confirmation = await dialogService.confirm({
			type: 'warning',
			message,
			detail,
			primaryButton
		});
	}

	// Check for confirmation checkbox
	if (confirmation.confirmed && confirmation.checkboxChecked === true) {
		await configurationService.updateValue(CONFIRM_DELETE_SETTING_KEY, false);
	}

	// Check for confirmation
	if (!confirmation.confirmed) {
		return;
	}

	// Call function
	try {
		const resourceFileEdits = distinctElements.map(e => new ResourceFileEdit(e.resource, undefined, { recursive: true, folder: e.isDirectory, ignoreIfNotExists, skipTrashBin: !useTrash, maxSize: MAX_UNDO_FILE_SIZE }));
		const options = {
			undoLabel: distinctElements.length > 1 ? nls.localize({ key: 'deleteBulkEdit', comment: ['Placeholder will be replaced by the number of files deleted'] }, "Delete {0} files", distinctElements.length) : nls.localize({ key: 'deleteFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file deleted'] }, "Delete {0}", distinctElements[0].name),
			progressLabel: distinctElements.length > 1 ? nls.localize({ key: 'deletingBulkEdit', comment: ['Placeholder will be replaced by the number of files deleted'] }, "Deleting {0} files", distinctElements.length) : nls.localize({ key: 'deletingFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file deleted'] }, "Deleting {0}", distinctElements[0].name),
		};
		await explorerService.applyBulkEdit(resourceFileEdits, options);
	} catch (error) {

		// Handle error to delete file(s) from a modal confirmation dialog
		let errorMessage: string;
		let detailMessage: string | undefined;
		let primaryButton: string;
		if (useTrash) {
			errorMessage = isWindows ? nls.localize('binFailed', "Failed to delete using the Recycle Bin. Do you want to permanently delete instead?") : nls.localize('trashFailed', "Failed to delete using the Trash. Do you want to permanently delete instead?");
			detailMessage = deleteDetail;
			primaryButton = nls.localize({ key: 'deletePermanentlyButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Delete Permanently");
		} else {
			errorMessage = toErrorMessage(error, false);
			primaryButton = nls.localize({ key: 'retryButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Retry");
		}

		const res = await dialogService.confirm({
			type: 'warning',
			message: errorMessage,
			detail: detailMessage,
			primaryButton
		});

		if (res.confirmed) {
			if (useTrash) {
				useTrash = false; // Delete Permanently
			}

			skipConfirm = true;
			ignoreIfNotExists = true;

			return deleteFiles(explorerService, workingCopyFileService, dialogService, configurationService, elements, useTrash, skipConfirm, ignoreIfNotExists);
		}
	}
}

function getMoveToTrashMessage(distinctElements: ExplorerItem[]): { message: string; detail: string } {
	if (containsBothDirectoryAndFile(distinctElements)) {
		return {
			message: nls.localize('confirmMoveTrashMessageFilesAndDirectories', "Are you sure you want to delete the following {0} files/directories and their contents?", distinctElements.length),
			detail: getFileNamesMessage(distinctElements.map(e => e.resource))
		};
	}

	if (distinctElements.length > 1) {
		if (distinctElements[0].isDirectory) {
			return {
				message: nls.localize('confirmMoveTrashMessageMultipleDirectories', "Are you sure you want to delete the following {0} directories and their contents?", distinctElements.length),
				detail: getFileNamesMessage(distinctElements.map(e => e.resource))
			};
		}

		return {
			message: nls.localize('confirmMoveTrashMessageMultiple', "Are you sure you want to delete the following {0} files?", distinctElements.length),
			detail: getFileNamesMessage(distinctElements.map(e => e.resource))
		};
	}

	if (distinctElements[0].isDirectory && !distinctElements[0].isSymbolicLink) {
		return { message: nls.localize('confirmMoveTrashMessageFolder', "Are you sure you want to delete '{0}' and its contents?", distinctElements[0].name), detail: '' };
	}

	return { message: nls.localize('confirmMoveTrashMessageFile', "Are you sure you want to delete '{0}'?", distinctElements[0].name), detail: '' };
}

function getDeleteMessage(distinctElements: ExplorerItem[]): { message: string; detail: string } {
	if (containsBothDirectoryAndFile(distinctElements)) {
		return {
			message: nls.localize('confirmDeleteMessageFilesAndDirectories', "Are you sure you want to permanently delete the following {0} files/directories and their contents?", distinctElements.length),
			detail: getFileNamesMessage(distinctElements.map(e => e.resource))
		};
	}

	if (distinctElements.length > 1) {
		if (distinctElements[0].isDirectory) {
			return {
				message: nls.localize('confirmDeleteMessageMultipleDirectories', "Are you sure you want to permanently delete the following {0} directories and their contents?", distinctElements.length),
				detail: getFileNamesMessage(distinctElements.map(e => e.resource))
			};
		}

		return {
			message: nls.localize('confirmDeleteMessageMultiple', "Are you sure you want to permanently delete the following {0} files?", distinctElements.length),
			detail: getFileNamesMessage(distinctElements.map(e => e.resource))
		};
	}

	if (distinctElements[0].isDirectory) {
		return { message: nls.localize('confirmDeleteMessageFolder', "Are you sure you want to permanently delete '{0}' and its contents?", distinctElements[0].name), detail: '' };
	}

	return { message: nls.localize('confirmDeleteMessageFile', "Are you sure you want to permanently delete '{0}'?", distinctElements[0].name), detail: '' };
}

function containsBothDirectoryAndFile(distinctElements: ExplorerItem[]): boolean {
	const directory = distinctElements.find(element => element.isDirectory);
	const file = distinctElements.find(element => !element.isDirectory);

	return !!directory && !!file;
}


export async function findValidPasteFileTarget(
	explorerService: IExplorerService,
	fileService: IFileService,
	dialogService: IDialogService,
	targetFolder: ExplorerItem,
	fileToPaste: { resource: URI; isDirectory?: boolean; allowOverwrite: boolean },
	incrementalNaming: 'simple' | 'smart' | 'disabled'
): Promise<URI | undefined> {

	let name = resources.basenameOrAuthority(fileToPaste.resource);
	let candidate = resources.joinPath(targetFolder.resource, name);

	// In the disabled case we must ask if it's ok to overwrite the file if it exists
	if (incrementalNaming === 'disabled') {
		const canOverwrite = await askForOverwrite(fileService, dialogService, candidate);
		if (!canOverwrite) {
			return;
		}
	}

	while (true && !fileToPaste.allowOverwrite) {
		if (!explorerService.findClosest(candidate)) {
			break;
		}

		if (incrementalNaming !== 'disabled') {
			name = incrementFileName(name, !!fileToPaste.isDirectory, incrementalNaming);
		}
		candidate = resources.joinPath(targetFolder.resource, name);
	}

	return candidate;
}

export function incrementFileName(name: string, isFolder: boolean, incrementalNaming: 'simple' | 'smart'): string {
	if (incrementalNaming === 'simple') {
		let namePrefix = name;
		let extSuffix = '';
		if (!isFolder) {
			extSuffix = extname(name);
			namePrefix = basename(name, extSuffix);
		}

		// name copy 5(.txt) => name copy 6(.txt)
		// name copy(.txt) => name copy 2(.txt)
		const suffixRegex = /^(.+ copy)( \d+)?$/;
		if (suffixRegex.test(namePrefix)) {
			return namePrefix.replace(suffixRegex, (match, g1?, g2?) => {
				const number = (g2 ? parseInt(g2) : 1);
				return number === 0
					? `${g1}`
					: (number < Constants.MAX_SAFE_SMALL_INTEGER
						? `${g1} ${number + 1}`
						: `${g1}${g2} copy`);
			}) + extSuffix;
		}

		// name(.txt) => name copy(.txt)
		return `${namePrefix} copy${extSuffix}`;
	}

	const separators = '[\\.\\-_]';
	const maxNumber = Constants.MAX_SAFE_SMALL_INTEGER;

	// file.1.txt=>file.2.txt
	const suffixFileRegex = RegExp('(.*' + separators + ')(\\d+)(\\..*)$');
	if (!isFolder && name.match(suffixFileRegex)) {
		return name.replace(suffixFileRegex, (match, g1?, g2?, g3?) => {
			const number = parseInt(g2);
			return number < maxNumber
				? g1 + String(number + 1).padStart(g2.length, '0') + g3
				: `${g1}${g2}.1${g3}`;
		});
	}

	// 1.file.txt=>2.file.txt
	const prefixFileRegex = RegExp('(\\d+)(' + separators + '.*)(\\..*)$');
	if (!isFolder && name.match(prefixFileRegex)) {
		return name.replace(prefixFileRegex, (match, g1?, g2?, g3?) => {
			const number = parseInt(g1);
			return number < maxNumber
				? String(number + 1).padStart(g1.length, '0') + g2 + g3
				: `${g1}${g2}.1${g3}`;
		});
	}

	// 1.txt=>2.txt
	const prefixFileNoNameRegex = RegExp('(\\d+)(\\..*)$');
	if (!isFolder && name.match(prefixFileNoNameRegex)) {
		return name.replace(prefixFileNoNameRegex, (match, g1?, g2?) => {
			const number = parseInt(g1);
			return number < maxNumber
				? String(number + 1).padStart(g1.length, '0') + g2
				: `${g1}.1${g2}`;
		});
	}

	// file.txt=>file.1.txt
	const lastIndexOfDot = name.lastIndexOf('.');
	if (!isFolder && lastIndexOfDot >= 0) {
		return `${name.substr(0, lastIndexOfDot)}.1${name.substr(lastIndexOfDot)}`;
	}

	// 123 => 124
	const noNameNoExtensionRegex = RegExp('(\\d+)$');
	if (!isFolder && lastIndexOfDot === -1 && name.match(noNameNoExtensionRegex)) {
		return name.replace(noNameNoExtensionRegex, (match, g1?) => {
			const number = parseInt(g1);
			return number < maxNumber
				? String(number + 1).padStart(g1.length, '0')
				: `${g1}.1`;
		});
	}

	// file => file1
	// file1 => file2
	const noExtensionRegex = RegExp('(.*)(\\d*)$');
	if (!isFolder && lastIndexOfDot === -1 && name.match(noExtensionRegex)) {
		return name.replace(noExtensionRegex, (match, g1?, g2?) => {
			let number = parseInt(g2);
			if (isNaN(number)) {
				number = 0;
			}
			return number < maxNumber
				? g1 + String(number + 1).padStart(g2.length, '0')
				: `${g1}${g2}.1`;
		});
	}

	// folder.1=>folder.2
	if (isFolder && name.match(/(\d+)$/)) {
		return name.replace(/(\d+)$/, (match, ...groups) => {
			const number = parseInt(groups[0]);
			return number < maxNumber
				? String(number + 1).padStart(groups[0].length, '0')
				: `${groups[0]}.1`;
		});
	}

	// 1.folder=>2.folder
	if (isFolder && name.match(/^(\d+)/)) {
		return name.replace(/^(\d+)(.*)$/, (match, ...groups) => {
			const number = parseInt(groups[0]);
			return number < maxNumber
				? String(number + 1).padStart(groups[0].length, '0') + groups[1]
				: `${groups[0]}${groups[1]}.1`;
		});
	}

	// file/folder=>file.1/folder.1
	return `${name}.1`;
}

/**
 * Checks to see if the resource already exists, if so prompts the user if they would be ok with it being overwritten
 * @param fileService The file service
 * @param dialogService The dialog service
 * @param targetResource The resource to be overwritten
 * @return A boolean indicating if the user is ok with resource being overwritten, if the resource does not exist it returns true.
 */
async function askForOverwrite(fileService: IFileService, dialogService: IDialogService, targetResource: URI): Promise<boolean> {
	const exists = await fileService.exists(targetResource);
	if (!exists) {
		return true;
	}
	// Ask for overwrite confirmation
	const { confirmed } = await dialogService.confirm({
		type: Severity.Warning,
		message: nls.localize('confirmOverwrite', "A file or folder with the name '{0}' already exists in the destination folder. Do you want to replace it?", basename(targetResource.path)),
		primaryButton: nls.localize('replaceButtonLabel', "&&Replace")
	});
	return confirmed;
}

// Global Compare with
export class GlobalCompareResourcesAction extends Action2 {

	static readonly ID = 'workbench.files.action.compareFileWith';
	static readonly LABEL = nls.localize('globalCompareFile', "Compare Active File With...");

	constructor() {
		super({
			id: GlobalCompareResourcesAction.ID,
			title: { value: GlobalCompareResourcesAction.LABEL, original: 'Compare Active File With...' },
			f1: true,
			category: fileCategory,
			precondition: ActiveEditorContext
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const textModelService = accessor.get(ITextModelService);
		const quickInputService = accessor.get(IQuickInputService);

		const activeInput = editorService.activeEditor;
		const activeResource = EditorResourceAccessor.getOriginalUri(activeInput);
		if (activeResource && textModelService.canHandleResource(activeResource)) {
			const picks = await quickInputService.quickAccess.pick('', { itemActivation: ItemActivation.SECOND });
			if (picks?.length === 1) {
				const resource = (picks[0] as unknown as { resource: unknown }).resource;
				if (URI.isUri(resource) && textModelService.canHandleResource(resource)) {
					editorService.openEditor({
						original: { resource: activeResource },
						modified: { resource: resource },
						options: { pinned: true }
					});
				}
			}
		}
	}
}

export class ToggleAutoSaveAction extends Action2 {
	static readonly ID = 'workbench.action.toggleAutoSave';
	static readonly LABEL = nls.localize('toggleAutoSave', "Toggle Auto Save");

	constructor() {
		super({
			id: ToggleAutoSaveAction.ID,
			title: { value: ToggleAutoSaveAction.LABEL, original: 'Toggle Auto Save' },
			f1: true,
			category: fileCategory
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const filesConfigurationService = accessor.get(IFilesConfigurationService);
		return filesConfigurationService.toggleAutoSave();
	}
}

abstract class BaseSaveAllAction extends Action {
	private lastDirtyState: boolean;

	constructor(
		id: string,
		label: string,
		@ICommandService protected commandService: ICommandService,
		@INotificationService private notificationService: INotificationService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService
	) {
		super(id, label);

		this.lastDirtyState = this.workingCopyService.hasDirty;
		this.enabled = this.lastDirtyState;

		this.registerListeners();
	}

	protected abstract doRun(context: unknown): Promise<void>;

	private registerListeners(): void {

		// update enablement based on working copy changes
		this._register(this.workingCopyService.onDidChangeDirty(workingCopy => this.updateEnablement(workingCopy)));
	}

	private updateEnablement(workingCopy: IWorkingCopy): void {
		const hasDirty = workingCopy.isDirty() || this.workingCopyService.hasDirty;
		if (this.lastDirtyState !== hasDirty) {
			this.enabled = hasDirty;
			this.lastDirtyState = this.enabled;
		}
	}

	override async run(context?: unknown): Promise<void> {
		try {
			await this.doRun(context);
		} catch (error) {
			onError(this.notificationService, error);
		}
	}
}

export class SaveAllInGroupAction extends BaseSaveAllAction {

	static readonly ID = 'workbench.files.action.saveAllInGroup';
	static readonly LABEL = nls.localize('saveAllInGroup', "Save All in Group");

	override get class(): string {
		return 'explorer-action ' + ThemeIcon.asClassName(Codicon.saveAll);
	}

	protected doRun(context: unknown): Promise<void> {
		return this.commandService.executeCommand(SAVE_ALL_IN_GROUP_COMMAND_ID, {}, context);
	}
}

export class CloseGroupAction extends Action {

	static readonly ID = 'workbench.files.action.closeGroup';
	static readonly LABEL = nls.localize('closeGroup', "Close Group");

	constructor(id: string, label: string, @ICommandService private readonly commandService: ICommandService) {
		super(id, label, ThemeIcon.asClassName(Codicon.closeAll));
	}

	override run(context?: unknown): Promise<void> {
		return this.commandService.executeCommand(CLOSE_EDITORS_AND_GROUP_COMMAND_ID, {}, context);
	}
}

export class FocusFilesExplorer extends Action2 {

	static readonly ID = 'workbench.files.action.focusFilesExplorer';
	static readonly LABEL = nls.localize('focusFilesExplorer', "Focus on Files Explorer");

	constructor() {
		super({
			id: FocusFilesExplorer.ID,
			title: { value: FocusFilesExplorer.LABEL, original: 'Focus on Files Explorer' },
			f1: true,
			category: fileCategory
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const paneCompositeService = accessor.get(IPaneCompositePartService);
		await paneCompositeService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar, true);
	}
}

export class ShowActiveFileInExplorer extends Action2 {

	static readonly ID = 'workbench.files.action.showActiveFileInExplorer';
	static readonly LABEL = nls.localize('showInExplorer', "Reveal Active File in Explorer View");

	constructor() {
		super({
			id: ShowActiveFileInExplorer.ID,
			title: { value: ShowActiveFileInExplorer.LABEL, original: 'Reveal Active File in Explorer View' },
			f1: true,
			category: fileCategory
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const resource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (resource) {
			commandService.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, resource);
		}
	}
}

export class ShowOpenedFileInNewWindow extends Action2 {

	static readonly ID = 'workbench.action.files.showOpenedFileInNewWindow';
	static readonly LABEL = nls.localize('openFileInNewWindow', "Open Active File in New Window");

	constructor(
	) {
		super({
			id: ShowOpenedFileInNewWindow.ID,
			title: { value: ShowOpenedFileInNewWindow.LABEL, original: 'Open Active File in New Window' },
			f1: true,
			category: fileCategory,
			keybinding: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyO), weight: KeybindingWeight.WorkbenchContrib },
			precondition: EmptyWorkspaceSupportContext
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const hostService = accessor.get(IHostService);
		const dialogService = accessor.get(IDialogService);
		const fileService = accessor.get(IFileService);

		const fileResource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (fileResource) {
			if (fileService.hasProvider(fileResource)) {
				hostService.openWindow([{ fileUri: fileResource }], { forceNewWindow: true });
			} else {
				dialogService.error(nls.localize('openFileToShowInNewWindow.unsupportedschema', "The active editor must contain an openable resource."));
			}
		}
	}
}

export function validateFileName(pathService: IPathService, item: ExplorerItem, name: string, os: OperatingSystem): { content: string; severity: Severity } | null {
	// Produce a well formed file name
	name = getWellFormedFileName(name);

	// Name not provided
	if (!name || name.length === 0 || /^\s+$/.test(name)) {
		return {
			content: nls.localize('emptyFileNameError', "A file or folder name must be provided."),
			severity: Severity.Error
		};
	}

	// Relative paths only
	if (name[0] === '/' || name[0] === '\\') {
		return {
			content: nls.localize('fileNameStartsWithSlashError', "A file or folder name cannot start with a slash."),
			severity: Severity.Error
		};
	}

	const names = coalesce(name.split(/[\\/]/));
	const parent = item.parent;

	if (name !== item.name) {
		// Do not allow to overwrite existing file
		const child = parent?.getChild(name);
		if (child && child !== item) {
			return {
				content: nls.localize('fileNameExistsError', "A file or folder **{0}** already exists at this location. Please choose a different name.", name),
				severity: Severity.Error
			};
		}
	}

	// Check for invalid file name.
	if (names.some(folderName => !pathService.hasValidBasename(item.resource, os, folderName))) {
		// Escape * characters
		const escapedName = name.replace(/\*/g, '\\*');
		return {
			content: nls.localize('invalidFileNameError', "The name **{0}** is not valid as a file or folder name. Please choose a different name.", trimLongName(escapedName)),
			severity: Severity.Error
		};
	}

	if (names.some(name => /^\s|\s$/.test(name))) {
		return {
			content: nls.localize('fileNameWhitespaceWarning', "Leading or trailing whitespace detected in file or folder name."),
			severity: Severity.Warning
		};
	}

	return null;
}

function trimLongName(name: string): string {
	if (name?.length > 255) {
		return `${name.substr(0, 255)}...`;
	}

	return name;
}

function getWellFormedFileName(filename: string): string {
	if (!filename) {
		return filename;
	}

	// Trim tabs
	filename = trim(filename, '\t');

	// Remove trailing slashes
	filename = rtrim(filename, '/');
	filename = rtrim(filename, '\\');

	return filename;
}

export class CompareNewUntitledTextFilesAction extends Action2 {

	static readonly ID = 'workbench.files.action.compareNewUntitledTextFiles';
	static readonly LABEL = nls.localize('compareNewUntitledTextFiles', "Compare New Untitled Text Files");

	constructor() {
		super({
			id: CompareNewUntitledTextFilesAction.ID,
			title: { value: CompareNewUntitledTextFilesAction.LABEL, original: 'Compare New Untitled Text Files' },
			f1: true,
			category: fileCategory
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);

		await editorService.openEditor({
			original: { resource: undefined },
			modified: { resource: undefined },
			options: { pinned: true }
		});
	}
}

export class CompareWithClipboardAction extends Action2 {

	static readonly ID = 'workbench.files.action.compareWithClipboard';
	static readonly LABEL = nls.localize('compareWithClipboard', "Compare Active File with Clipboard");

	private registrationDisposal: IDisposable | undefined;
	private static SCHEME_COUNTER = 0;

	constructor() {
		super({
			id: CompareWithClipboardAction.ID,
			title: { value: CompareWithClipboardAction.LABEL, original: 'Compare Active File with Clipboard' },
			f1: true,
			category: fileCategory,
			keybinding: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyC), weight: KeybindingWeight.WorkbenchContrib }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const textModelService = accessor.get(ITextModelService);
		const fileService = accessor.get(IFileService);

		const resource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		const scheme = `clipboardCompare${CompareWithClipboardAction.SCHEME_COUNTER++}`;
		if (resource && (fileService.hasProvider(resource) || resource.scheme === Schemas.untitled)) {
			if (!this.registrationDisposal) {
				const provider = instantiationService.createInstance(ClipboardContentProvider);
				this.registrationDisposal = textModelService.registerTextModelContentProvider(scheme, provider);
			}

			const name = resources.basename(resource);
			const editorLabel = nls.localize('clipboardComparisonLabel', "Clipboard ↔ {0}", name);

			await editorService.openEditor({
				original: { resource: resource.with({ scheme }) },
				modified: { resource: resource },
				label: editorLabel,
				options: { pinned: true }
			}).finally(() => {
				dispose(this.registrationDisposal);
				this.registrationDisposal = undefined;
			});
		}
	}

	dispose(): void {
		dispose(this.registrationDisposal);
		this.registrationDisposal = undefined;
	}
}

class ClipboardContentProvider implements ITextModelContentProvider {
	constructor(
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel> {
		const text = await this.clipboardService.readText();
		const model = this.modelService.createModel(text, this.languageService.createByFilepathOrFirstLine(resource), resource);

		return model;
	}
}

function onErrorWithRetry(notificationService: INotificationService, error: unknown, retry: () => Promise<unknown>): void {
	notificationService.prompt(Severity.Error, toErrorMessage(error, false),
		[{
			label: nls.localize('retry', "Retry"),
			run: () => retry()
		}]
	);
}

async function openExplorerAndCreate(accessor: ServicesAccessor, isFolder: boolean): Promise<void> {
	const explorerService = accessor.get(IExplorerService);
	const fileService = accessor.get(IFileService);
	const configService = accessor.get(IConfigurationService);
	const editorService = accessor.get(IEditorService);
	const viewsService = accessor.get(IViewsService);
	const notificationService = accessor.get(INotificationService);
	const remoteAgentService = accessor.get(IRemoteAgentService);
	const commandService = accessor.get(ICommandService);
	const pathService = accessor.get(IPathService);

	const wasHidden = !viewsService.isViewVisible(VIEW_ID);
	const view = await viewsService.openView(VIEW_ID, true);
	if (wasHidden) {
		// Give explorer some time to resolve itself #111218
		await timeout(500);
	}
	if (!view) {
		// Can happen in empty workspace case (https://github.com/microsoft/vscode/issues/100604)

		if (isFolder) {
			throw new Error('Open a folder or workspace first.');
		}

		return commandService.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);
	}

	const stats = explorerService.getContext(false);
	const stat = stats.length > 0 ? stats[0] : undefined;
	let folder: ExplorerItem;
	if (stat) {
		folder = stat.isDirectory ? stat : (stat.parent || explorerService.roots[0]);
	} else {
		folder = explorerService.roots[0];
	}

	if (folder.isReadonly) {
		throw new Error('Parent folder is readonly.');
	}

	const newStat = new NewExplorerItem(fileService, configService, folder, isFolder);
	folder.addChild(newStat);

	const onSuccess = async (value: string): Promise<void> => {
		try {
			const resourceToCreate = resources.joinPath(folder.resource, value);
			await explorerService.applyBulkEdit([new ResourceFileEdit(undefined, resourceToCreate, { folder: isFolder })], {
				undoLabel: nls.localize('createBulkEdit', "Create {0}", value),
				progressLabel: nls.localize('creatingBulkEdit', "Creating {0}", value),
				confirmBeforeUndo: true
			});
			await refreshIfSeparator(value, explorerService);

			if (isFolder) {
				await explorerService.select(resourceToCreate, true);
			} else {
				await editorService.openEditor({ resource: resourceToCreate, options: { pinned: true } });
			}
		} catch (error) {
			onErrorWithRetry(notificationService, error, () => onSuccess(value));
		}
	};

	const os = (await remoteAgentService.getEnvironment())?.os ?? OS;

	await explorerService.setEditable(newStat, {
		validationMessage: value => validateFileName(pathService, newStat, value, os),
		onFinish: async (value, success) => {
			folder.removeChild(newStat);
			await explorerService.setEditable(newStat, null);
			if (success) {
				onSuccess(value);
			}
		}
	});
}

CommandsRegistry.registerCommand({
	id: NEW_FILE_COMMAND_ID,
	handler: async (accessor) => {
		await openExplorerAndCreate(accessor, false);
	}
});

CommandsRegistry.registerCommand({
	id: NEW_FOLDER_COMMAND_ID,
	handler: async (accessor) => {
		await openExplorerAndCreate(accessor, true);
	}
});

export const renameHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const notificationService = accessor.get(INotificationService);
	const remoteAgentService = accessor.get(IRemoteAgentService);
	const pathService = accessor.get(IPathService);
	const configurationService = accessor.get(IConfigurationService);

	const stats = explorerService.getContext(false);
	const stat = stats.length > 0 ? stats[0] : undefined;
	if (!stat) {
		return;
	}

	const os = (await remoteAgentService.getEnvironment())?.os ?? OS;

	await explorerService.setEditable(stat, {
		validationMessage: value => validateFileName(pathService, stat, value, os),
		onFinish: async (value, success) => {
			if (success) {
				const parentResource = stat.parent!.resource;
				const targetResource = resources.joinPath(parentResource, value);
				if (stat.resource.toString() !== targetResource.toString()) {
					try {
						await explorerService.applyBulkEdit([new ResourceFileEdit(stat.resource, targetResource)], {
							confirmBeforeUndo: configurationService.getValue<IFilesConfiguration>().explorer.confirmUndo === UndoConfirmLevel.Verbose,
							undoLabel: nls.localize('renameBulkEdit', "Rename {0} to {1}", stat.name, value),
							progressLabel: nls.localize('renamingBulkEdit', "Renaming {0} to {1}", stat.name, value),
						});
						await refreshIfSeparator(value, explorerService);
					} catch (e) {
						notificationService.error(e);
					}
				}
			}
			await explorerService.setEditable(stat, null);
		}
	});
};

export const moveFileToTrashHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const stats = explorerService.getContext(true).filter(s => !s.isRoot);
	if (stats.length) {
		await deleteFiles(accessor.get(IExplorerService), accessor.get(IWorkingCopyFileService), accessor.get(IDialogService), accessor.get(IConfigurationService), stats, true);
	}
};

export const deleteFileHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const stats = explorerService.getContext(true).filter(s => !s.isRoot);

	if (stats.length) {
		await deleteFiles(accessor.get(IExplorerService), accessor.get(IWorkingCopyFileService), accessor.get(IDialogService), accessor.get(IConfigurationService), stats, false);
	}
};

let pasteShouldMove = false;
export const copyFileHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const stats = explorerService.getContext(true);
	if (stats.length > 0) {
		await explorerService.setToCopy(stats, false);
		pasteShouldMove = false;
	}
};

export const cutFileHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const stats = explorerService.getContext(true);
	if (stats.length > 0) {
		await explorerService.setToCopy(stats, true);
		pasteShouldMove = true;
	}
};

const downloadFileHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);

	const context = explorerService.getContext(true);
	const explorerItems = context.length ? context : explorerService.roots;

	const downloadHandler = instantiationService.createInstance(FileDownload);

	try {
		await downloadHandler.download(explorerItems);
	} catch (error) {
		notificationService.error(error);

		throw error;
	}
};

CommandsRegistry.registerCommand({
	id: DOWNLOAD_COMMAND_ID,
	handler: downloadFileHandler
});

const uploadFileHandler = async (accessor: ServicesAccessor) => {
	const explorerService = accessor.get(IExplorerService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);

	const context = explorerService.getContext(true);
	const element = context.length ? context[0] : explorerService.roots[0];

	try {
		const files = await triggerUpload();
		if (files) {
			const browserUpload = instantiationService.createInstance(BrowserFileUpload);
			await browserUpload.upload(element, files);
		}
	} catch (error) {
		notificationService.error(error);

		throw error;
	}
};

CommandsRegistry.registerCommand({
	id: UPLOAD_COMMAND_ID,
	handler: uploadFileHandler
});

export const pasteFileHandler = async (accessor: ServicesAccessor) => {
	const clipboardService = accessor.get(IClipboardService);
	const explorerService = accessor.get(IExplorerService);
	const fileService = accessor.get(IFileService);
	const notificationService = accessor.get(INotificationService);
	const editorService = accessor.get(IEditorService);
	const configurationService = accessor.get(IConfigurationService);
	const uriIdentityService = accessor.get(IUriIdentityService);
	const dialogService = accessor.get(IDialogService);

	const context = explorerService.getContext(true);
	const toPaste = resources.distinctParents(await clipboardService.readResources(), r => r);
	const element = context.length ? context[0] : explorerService.roots[0];
	const incrementalNaming = configurationService.getValue<IFilesConfiguration>().explorer.incrementalNaming;

	try {
		// Check if target is ancestor of pasted folder
		const sourceTargetPairs = coalesce(await Promise.all(toPaste.map(async fileToPaste => {

			if (element.resource.toString() !== fileToPaste.toString() && resources.isEqualOrParent(element.resource, fileToPaste)) {
				throw new Error(nls.localize('fileIsAncestor', "File to paste is an ancestor of the destination folder"));
			}
			const fileToPasteStat = await fileService.stat(fileToPaste);

			// Find target
			let target: ExplorerItem;
			if (uriIdentityService.extUri.isEqual(element.resource, fileToPaste)) {
				target = element.parent!;
			} else {
				target = element.isDirectory ? element : element.parent!;
			}

			const targetFile = await findValidPasteFileTarget(
				explorerService,
				fileService,
				dialogService,
				target,
				{ resource: fileToPaste, isDirectory: fileToPasteStat.isDirectory, allowOverwrite: pasteShouldMove || incrementalNaming === 'disabled' },
				incrementalNaming
			);

			if (!targetFile) {
				return undefined;
			}

			return { source: fileToPaste, target: targetFile };
		})));

		if (sourceTargetPairs.length >= 1) {
			// Move/Copy File
			if (pasteShouldMove) {
				const resourceFileEdits = sourceTargetPairs.map(pair => new ResourceFileEdit(pair.source, pair.target, { overwrite: incrementalNaming === 'disabled' }));
				const options = {
					confirmBeforeUndo: configurationService.getValue<IFilesConfiguration>().explorer.confirmUndo === UndoConfirmLevel.Verbose,
					progressLabel: sourceTargetPairs.length > 1 ? nls.localize({ key: 'movingBulkEdit', comment: ['Placeholder will be replaced by the number of files being moved'] }, "Moving {0} files", sourceTargetPairs.length)
						: nls.localize({ key: 'movingFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file moved.'] }, "Moving {0}", resources.basenameOrAuthority(sourceTargetPairs[0].target)),
					undoLabel: sourceTargetPairs.length > 1 ? nls.localize({ key: 'moveBulkEdit', comment: ['Placeholder will be replaced by the number of files being moved'] }, "Move {0} files", sourceTargetPairs.length)
						: nls.localize({ key: 'moveFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file moved.'] }, "Move {0}", resources.basenameOrAuthority(sourceTargetPairs[0].target))
				};
				await explorerService.applyBulkEdit(resourceFileEdits, options);
			} else {
				const resourceFileEdits = sourceTargetPairs.map(pair => new ResourceFileEdit(pair.source, pair.target, { copy: true, overwrite: incrementalNaming === 'disabled' }));
				const undoLevel = configurationService.getValue<IFilesConfiguration>().explorer.confirmUndo;
				const options = {
					confirmBeforeUndo: undoLevel === UndoConfirmLevel.Default || undoLevel === UndoConfirmLevel.Verbose,
					progressLabel: sourceTargetPairs.length > 1 ? nls.localize({ key: 'copyingBulkEdit', comment: ['Placeholder will be replaced by the number of files being copied'] }, "Copying {0} files", sourceTargetPairs.length)
						: nls.localize({ key: 'copyingFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file copied.'] }, "Copying {0}", resources.basenameOrAuthority(sourceTargetPairs[0].target)),
					undoLabel: sourceTargetPairs.length > 1 ? nls.localize({ key: 'copyBulkEdit', comment: ['Placeholder will be replaced by the number of files being copied'] }, "Paste {0} files", sourceTargetPairs.length)
						: nls.localize({ key: 'copyFileBulkEdit', comment: ['Placeholder will be replaced by the name of the file copied.'] }, "Paste {0}", resources.basenameOrAuthority(sourceTargetPairs[0].target))
				};
				await explorerService.applyBulkEdit(resourceFileEdits, options);
			}

			const pair = sourceTargetPairs[0];
			await explorerService.select(pair.target);
			if (sourceTargetPairs.length === 1) {
				const item = explorerService.findClosest(pair.target);
				if (item && !item.isDirectory) {
					await editorService.openEditor({ resource: item.resource, options: { pinned: true, preserveFocus: true } });
				}
			}
		}
	} catch (e) {
		onError(notificationService, new Error(nls.localize('fileDeleted', "The file(s) to paste have been deleted or moved since you copied them. {0}", getErrorMessage(e))));
	} finally {
		if (pasteShouldMove) {
			// Cut is done. Make sure to clear cut state.
			await explorerService.setToCopy([], false);
			pasteShouldMove = false;
		}
	}
};

export const openFilePreserveFocusHandler = async (accessor: ServicesAccessor) => {
	const editorService = accessor.get(IEditorService);
	const explorerService = accessor.get(IExplorerService);
	const stats = explorerService.getContext(true);

	await editorService.openEditors(stats.filter(s => !s.isDirectory).map(s => ({
		resource: s.resource,
		options: { preserveFocus: true }
	})));
};
