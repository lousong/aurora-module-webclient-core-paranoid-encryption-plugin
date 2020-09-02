'use strict';

require('modules/%ModuleName%/js/enums.js');

var
	_ = require('underscore'),

	TextUtils = require('%PathToCoreWebclientModule%/js/utils/Text.js'),
	
	Ajax = require('%PathToCoreWebclientModule%/js/Ajax.js'),
	App = require('%PathToCoreWebclientModule%/js/App.js'),
	Browser = require('%PathToCoreWebclientModule%/js/Browser.js'),
	Screens = require('%PathToCoreWebclientModule%/js/Screens.js'),
	
	Popups = require('%PathToCoreWebclientModule%/js/Popups.js'),
	AlertPopup = require('%PathToCoreWebclientModule%/js/popups/AlertPopup.js'),
	
	ConfirmEncryptionPopup = require('modules/%ModuleName%/js/popups/ConfirmEncryptionPopup.js'),
	ConfirmUploadPopup = require('modules/%ModuleName%/js/popups/ConfirmUploadPopup.js'),
	InitializationVectorPopup = require('modules/%ModuleName%/js/popups/InitializationVectorPopup.js'),
	
	Settings = require('modules/%ModuleName%/js/Settings.js'),
	
	Crypto = null,
	OpenPgpEncryptor = null,
	AwaitConfirmationQueue = [],	//List of files waiting for the user to decide on encryption
	isConfirmPopupShown = false,
	oButtonsView = null,
	FilesView = null
;

function IsHttpsEnable()
{
	return window.location.protocol === "https:";
}

function ShowUploadPopup(sUid, oFileInfo, fUpload, fCancel, sErrorText)
{
	if (isConfirmPopupShown)
	{
		AwaitConfirmationQueue.push({
			sUid: sUid,
			oFileInfo: oFileInfo
		});
	}
	else
	{
		setTimeout(function () {
			Popups.showPopup(ConfirmUploadPopup, [
				fUpload,
				fCancel,
				AwaitConfirmationQueue.length,
				_.map(AwaitConfirmationQueue, function(element) {
					return element.oFileInfo.FileName;
				}),
				sErrorText
			]);
		}, 10);
		isConfirmPopupShown = true;
		AwaitConfirmationQueue.push({
			sUid: sUid,
			oFileInfo: oFileInfo
		});
	}
}

function StartModule (ModulesManager)
{
	ModulesManager.run('SettingsWebclient', 'registerSettingsTab', [
		function () { return require('modules/%ModuleName%/js/views/ParanoidEncryptionSettingsFormView.js'); },
		Settings.HashModuleName,
		TextUtils.i18n('%MODULENAME%/LABEL_SETTINGS_TAB')
	]);

	App.subscribeEvent('AbstractFileModel::FileDownload::before', function (oParams) {
		var
			oFile = oParams.File,
			oExtendedProps = oFile?.oExtendedProps || false,
			iv = oExtendedProps?.InitializationVector || false,
			sParanoidEncryptedKey = oExtendedProps?.ParanoidKey || false,
			sParanoidEncryptedKeyShared = oExtendedProps?.ParanoidKeyShared || false,
			bIsOwnFile = oFile.sOwnerName === App.getUserPublicId(),
			bIsSharedStorage = "storageType" in oFile
				? oFile.storageType() === Enums.FileStorageType.Shared
				: false
		;
		//User can decrypt only own or shared files
		if (!Settings.EnableJscrypto() || !iv
			|| !(bIsOwnFile || bIsSharedStorage))
		{
			//regular upload will start in Jua in this case
		}
		else if (!IsHttpsEnable())
		{
			Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_HTTPS_NEEDED'));
			oParams.CancelDownload = true;
		}
		else
		{
			oParams.CustomDownloadHandler = function () {
				Crypto.downloadDividedFile(
					oFile,
					iv,
					null,
					null,
					bIsSharedStorage && sParanoidEncryptedKeyShared
						? sParanoidEncryptedKeyShared
						: sParanoidEncryptedKey
				);
			};
		}
	});

	App.subscribeEvent('OpenPgpFilesWebclient::DownloadSecureFile', function (oParams) {
		var
			oFile = oParams.File,
			iv = oFile?.oExtendedProps?.InitializationVector || false,
			sParanoidEncryptedKey = oFile?.oExtendedProps?.ParanoidKey || false,
			fProcessBlobCallback = oParams.fProcessBlobCallback,
			fProcessBlobErrorCallback = oParams.fProcessBlobErrorCallback
		;

		//User can decrypt only own files
		if (!Settings.EnableJscrypto() || !iv || oFile.sOwnerName !== App.getUserPublicId())
		{
			Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_СANT_DECRYPT_FILE'));
			if (_.isFunction(fProcessBlobErrorCallback))
			{
				fProcessBlobErrorCallback();
			}
		}
		else if (!IsHttpsEnable())
		{
			Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_HTTPS_NEEDED'));
			oParams.CancelDownload = true;
			if (_.isFunction(fProcessBlobErrorCallback))
			{
				fProcessBlobErrorCallback();
			}
		}
		else
		{
			Crypto.downloadDividedFile(oFile, iv, fProcessBlobCallback, fProcessBlobErrorCallback, sParanoidEncryptedKey);
		}
	});

	App.subscribeEvent('Jua::FileUpload::before', function (oParams) {
		var
			sUid = oParams.sUid,
			sModuleName = oParams.sModuleName,
			oFileInfo = oParams.oFileInfo,
			fOnChunkEncryptCallback = oParams.fOnChunkReadyCallback,
			fRegularUploadFileCallback = oParams.fRegularUploadFileCallback,
			fCancelFunction = oParams.fCancelFunction,
			fStartUploadCallback = function (oFileInfo, sUid, fOnChunkEncryptCallback) {
				if (!Settings.AllowMultiChunkUpload && oFileInfo.File.size > Crypto.iChunkSize)
				{
					Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_FILE_SIZE_LIMIT', {'VALUE': Settings.ChunkSizeMb}));
					fCancelFunction(sUid);
					Crypto.oChunkQueue.isProcessed = false;
					Crypto.checkQueue();
				}
				else
				{
					// Starts upload an encrypted file
					Crypto.startUpload(
						oFileInfo,
						sUid,
						fOnChunkEncryptCallback,
						_.bind(function () {
							fCancelFunction(sUid);
							Crypto.oChunkQueue.isProcessed = false;
							Crypto.checkQueue();
						}, this)
					);
				}
			},
			fUpload = _.bind(function () {
				AwaitConfirmationQueue.forEach(function (element) {
					fRegularUploadFileCallback(element.sUid, element.oFileInfo);
				});
				AwaitConfirmationQueue = [];
				isConfirmPopupShown = false;
			}, this),
			fEncrypt = _.bind(function () {
				AwaitConfirmationQueue.forEach(function (element) {
					// if another file is being uploaded now - add a file to the queue
					Crypto.oChunkQueue.aFiles.push({
						fStartUploadCallback: fStartUploadCallback,
						oFileInfo: element.oFileInfo,
						sUid: element.sUid,
						fOnChunkEncryptCallback: fOnChunkEncryptCallback
					});
				});
				AwaitConfirmationQueue = [];
				isConfirmPopupShown = false;
				if (!Crypto.oChunkQueue.isProcessed)
				{
					Crypto.oChunkQueue.isProcessed = true;
					Crypto.checkQueue();
				}
			}),
			fCancel = _.bind(function () {
				AwaitConfirmationQueue.forEach(function (element) {
					fCancelFunction(element.sUid);
				});
				AwaitConfirmationQueue = [];
				isConfirmPopupShown = false;
			})
		;

		if (!Settings.EnableJscrypto()
			|| (
				Settings.EncryptionAllowedModules &&
				Settings.EncryptionAllowedModules.length > 0 &&
				!Settings.EncryptionAllowedModules.includes(sModuleName)
			)
			|| (!Settings.EncryptionAllowedStorages.includes(oParams.sStorageType) && oParams.sStorageType !== 'encrypted')
			|| Settings.EncryptionMode() === Enums.EncryptionMode.Never
			|| (Settings.EncryptionMode() === Enums.EncryptionMode.AlwaysInEncryptedFolder && oParams.sStorageType !== 'encrypted')
		)
		{
			fRegularUploadFileCallback(sUid, oFileInfo);
		}
		else if (!IsHttpsEnable())
		{
			if (Settings.EncryptionMode() === Enums.EncryptionMode.Always || Settings.EncryptionMode() === Enums.EncryptionMode.AlwaysInEncryptedFolder)
			{
				//for Always encryption mode show error
				Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_HTTPS_NEEDED'));
				fCancelFunction(sUid);
			}
			else if (Settings.EncryptionMode() === Enums.EncryptionMode.AskMe)
			{
				//for AskMe encryption mode show dialog with warning and regular upload button
				ShowUploadPopup(sUid, oFileInfo, fUpload, fCancel, TextUtils.i18n('%MODULENAME%/ERROR_HTTPS_NEEDED'));
			}
		}
		else
		{
			if (Settings.EncryptionMode() === Enums.EncryptionMode.AskMe)
			{
				if (isConfirmPopupShown)
				{
					AwaitConfirmationQueue.push({
						sUid: sUid,
						oFileInfo: oFileInfo
					});
				}
				else
				{
					setTimeout(function () {
						Popups.showPopup(ConfirmEncryptionPopup, [
							fEncrypt,
							fUpload,
							fCancel,
							AwaitConfirmationQueue.length,
							_.map(AwaitConfirmationQueue, function(element) {
								return element.oFileInfo.FileName;
							})
						]);
					}, 10);
					isConfirmPopupShown = true;
					AwaitConfirmationQueue.push({
						sUid: sUid,
						oFileInfo: oFileInfo
					});
				}
			}
			else
			{
				if (Crypto.oChunkQueue.isProcessed === true)
				{ // if another file is being uploaded now - add a file to the queue
					Crypto.oChunkQueue.aFiles.push({
						fStartUploadCallback: fStartUploadCallback,
						oFileInfo: oFileInfo,
						sUid: sUid,
						fOnChunkEncryptCallback: fOnChunkEncryptCallback
					});
				}
				else
				{ // If the queue is not busy - start uploading
					fStartUploadCallback(oFileInfo, sUid, fOnChunkEncryptCallback);
				}
			}
		}
	});

	App.subscribeEvent('CFilesView::FileDownloadCancel', function (oParams) {
		if (Settings.EnableJscrypto() && IsHttpsEnable())
		{
			oParams.oFile.stopDownloading();
		}
	});

	App.subscribeEvent('CFilesView::FileUploadCancel', function (oParams) {
		if (Settings.EnableJscrypto() && IsHttpsEnable())
		{
			//clear queue
			Crypto.oChunkQueue.aFiles.forEach(function (oData, index, array) {
					oParams.fOnUploadCancelCallback(oData.sUid, oData.oFileInfo.FileName);
			});
			Crypto.oChunkQueue.aFiles = [];

			Crypto.stopUploading(oParams.sFileUploadUid , oParams.fOnUploadCancelCallback, oParams.sFileUploadName);
		}
		else if (_.isFunction(oParams.fOnUploadCancelCallback))
		{
			oParams.fOnUploadCancelCallback(oParams.sFileUploadUid, oParams.sFileUploadName);
		}
	});
	App.subscribeEvent('Jua::FileUploadingError', function () {
		if (Settings.EnableJscrypto() && IsHttpsEnable())
		{
			Crypto.oChunkQueue.isProcessed = false;
			Crypto.checkQueue();
		}
	});
	App.subscribeEvent('FilesWebclient::ParseFile::after', function (aParams) {
		let
			oFile = aParams[0],
			oExtendedProps = oFile?.oExtendedProps || false,
			iv = oExtendedProps?.InitializationVector || false,
			bIsEncrypted = !!iv,
			sParanoidEncryptedKey = oExtendedProps?.ParanoidKey || false,
			sParanoidEncryptedKeyShared = oExtendedProps?.ParanoidKeyShared || false,
			bIsImage = (/\.(png|jpe?g|gif)$/).test(oFile.fileName().toLowerCase()),
			bIsOwnFile = oFile.sOwnerName === App.getUserPublicId(),
			bIsSharedStorage = "storageType" in oFile
				? oFile.storageType() === Enums.FileStorageType.Shared
				: false
		;

		if (bIsEncrypted)
		{
			oFile.thumbnailSrc('');
			if (
				(bIsOwnFile || bIsSharedStorage)
				&& bIsImage
				&& Settings.EnableJscrypto()
			)
			{// change view action for images
				oFile.oActionsData.view.Handler = () => {
					Crypto.viewEncryptedImage(
						oFile,
						iv,
						bIsSharedStorage && sParanoidEncryptedKeyShared
							? sParanoidEncryptedKeyShared
							: sParanoidEncryptedKey
					);
				};
			}
			else
			{// remove view action for non-images
				oFile.removeAction('view');
			}
			oFile.removeAction('list');
			oFile.bIsSecure(true);
			oFile.onSecureIconClick = (oItem) => {
				Popups.showPopup(InitializationVectorPopup, [oFile, iv]);
			};
		}
	});
	App.subscribeEvent('FileViewerWebclientPlugin::FilesCollection::after', function (oParams) {
		oParams.aFilesCollection(_.filter(oParams.aFilesCollection(), function (oArg) {
			return !(typeof(oArg.oExtendedProps) !== 'undefined' &&  typeof(oArg.oExtendedProps.InitializationVector) !== 'undefined');
		}));
	});


	Settings.EnableJscrypto.subscribe(function(newValue) {
		if (FilesView !== null)
		{
			FilesView.requestStorages();
		}
	});

	App.subscribeEvent('FilesWebclient::ConstructView::after', function (oParams) {
		if ('CFilesView' === oParams.Name)
		{
			FilesView = oParams.View;
		}
	});

	App.subscribeEvent('SharedFiles::UpdateShare::before', async oParams => {
		const oFile = oParams.oFileItem;
		const sParanoidEncryptedKey = oFile?.oExtendedProps?.ParanoidKey || '';
		const fUpdateParanoidKeyShared = ParanoidKeyShared => {
			//Update file extended props
			Ajax.send(
				'Files',
				'UpdateExtendedProps',
				{
					Type: oFile.storageType(),
					Path: oFile.path(),
					Name: oFile.fileName(),
					ExtendedProps: { ParanoidKeyShared }
				},
				oResponse => {
					if (oResponse.Result === true)
					{
						//continue sharing
						oParams.OnSuccessCallback();
					}
					else
					{
						Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_UPDATING_PRANOID_KEY'));
						oParams.OnErrorCallback();
					}
				},
				this
			);
		};
		if (!oParams.IsDir && sParanoidEncryptedKey)
		{//if file is encrypted
			if (oParams.Shares.length)
			{//if file was shared - encrypt Paranoid-key
				//get OpenPGP public keys for users who must have access
				const aSharesEmails = oParams.Shares.map(oShare => oShare.PublicId);
				let aPublicKeys = aSharesEmails.length ?
					OpenPgpEncryptor.findKeysByEmails(aSharesEmails, /*bIsPublic*/true)
					: [];
				if (aPublicKeys.length < aSharesEmails.length)
				{//if not for all users the keys were found - show an error
					let aEmailsFromKeys = aPublicKeys.map(oKey => oKey.getEmail());
					let aDifference = aSharesEmails.filter(email => !aEmailsFromKeys.includes(email));
					const sError = TextUtils.i18n('%MODULENAME%/ERROR_NO_PUBLIC_KEYS_FOR_USERS_PLURAL',
						{'USERS': aDifference.join(', ')}, null, aDifference.length);
					Screens.showError(sError);
					oParams.OnErrorCallback();
				}
				else
				{//encrypt Paranoid-key with found OpenPGP public keys
					const oPrivateKey = await OpenPgpEncryptor.getCurrentUserPrivateKey();
					if (oPrivateKey)
					{
						//get a password for decryption and signature operations
						let sPassword = await OpenPgpEncryptor.askForKeyPassword(oPrivateKey.getUser());
						if (sPassword === false)
						{//user cancel operation
							oParams.OnErrorCallback();
							return false;
						}
						//decrypt personal paranoid key
						let sParanoidKey = await Crypto.decryptParanoidKey(
							sParanoidEncryptedKey,
							sPassword
						);
						if (!sParanoidKey)
						{
							oParams.OnErrorCallback();
							return false;
						}
						//encrypt personal paranoid key with public keys
						const sEncryptedSharedKey = await Crypto.encryptParanoidKey(
							sParanoidKey,
							aPublicKeys,
							sPassword
						);
						if (sEncryptedSharedKey)
						{
							fUpdateParanoidKeyShared(sEncryptedSharedKey);
						}
					}
				}
			}
			else
			{//remove ParanoidKeyShared if file was unshared
				fUpdateParanoidKeyShared(null);
			}
		}
		else
		{//if file is not encrypted - continue sharing
			oParams.OnSuccessCallback();
		}
	});

	App.subscribeEvent('SharedFiles::OpenFilesSharePopup', oParams => {
		if (oParams.IsDir)
		{
			oParams.DialogHintText(TextUtils.i18n('%MODULENAME%/INFO_SHARING_FOLDER'));
		}
	});
}

function getButtonView()
{
	if (!oButtonsView)
	{
		oButtonsView = require('modules/%ModuleName%/js/views/ButtonsView.js');
	}

	return oButtonsView;
}

module.exports = function (oAppData) {
	Settings.init(oAppData);

	return {
		/**
		 * Runs before application start. Subscribes to the event before post displaying.
		 *
		 * @param {Object} ModulesManager
		 */
		start: function (ModulesManager) {
			Crypto = require('modules/%ModuleName%/js/CCrypto.js');
			ModulesManager.run('FilesWebclient', 'registerToolbarButtons', [getButtonView()]);
			OpenPgpEncryptor = ModulesManager.run('OpenPgpWebclient', 'getOpenPgpEncryptor');

			var bBlobSavingEnable = window.Blob && window.URL && _.isFunction(window.URL.createObjectURL);
			// Module can't work without saving blob and shouldn't be initialized.
			if (bBlobSavingEnable)
			{
				if (Browser.chrome && !IsHttpsEnable())
				{
					// Module can't work without https.0
					// Module should be initialized to display message about https enabling.
					StartModule(ModulesManager);
				}
				else if (window.crypto && window.crypto.subtle)
				{
					if (!Browser.edge)
					{
						StartModule(ModulesManager);

					}
					// var sPassword = window.crypto.getRandomValues(new Uint8Array(16));
					// // window.crypto can't work with PBKDF2 in Edge.
					// // Checks if it works (in case if it will work in Edge one day) and then inizializes module.
					// window.crypto.subtle.importKey('raw', sPassword, {name: 'PBKDF2'}, false, ['deriveBits', 'deriveKey'])
					// 	.then(function () {
					// 		StartModule(ModulesManager);
					// 	});
				}
			}
		}
	};
};
