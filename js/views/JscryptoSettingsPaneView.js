'use strict';

var
	_ = require('underscore'),
	$ = require('jquery'),
	ko = require('knockout'),
	
	TextUtils = require('%PathToCoreWebclientModule%/js/utils/Text.js'),
	
	ModulesManager = require('%PathToCoreWebclientModule%/js/ModulesManager.js'),
	Screens = require('%PathToCoreWebclientModule%/js/Screens.js'),
	UserSettings = require('%PathToCoreWebclientModule%/js/Settings.js'),
	
	CAbstractSettingsFormView = ModulesManager.run('SettingsWebclient', 'getAbstractSettingsFormViewClass'),
	
	Popups = require('%PathToCoreWebclientModule%/js/Popups.js'),
	ConfirmPopup = require('%PathToCoreWebclientModule%/js/popups/ConfirmPopup.js'),
	
	JscryptoKey = require('modules/%ModuleName%/js/JscryptoKey.js'),
	Settings = require('modules/%ModuleName%/js/Settings.js')
;

/**
 * @constructor
 */
function CJscryptoSettingsPaneView()
{
	CAbstractSettingsFormView.call(this, Settings.ServerModuleName);
	
	this.enableJscrypto = ko.observable(Settings.enableJscrypto());
	
	this.key = ko.observable(JscryptoKey.getKey());
	
	this.downloadLinkHref = ko.observable('#');

	this.setExportUrl();
	JscryptoKey.getKeyObservable().subscribe(function () {
		this.key(JscryptoKey.getKey());
		this.setExportUrl();
	}, this);
}

_.extendOwn(CJscryptoSettingsPaneView.prototype, CAbstractSettingsFormView.prototype);

CJscryptoSettingsPaneView.prototype.ViewTemplate = '%ModuleName%_JscryptoSettingsPaneView';

CJscryptoSettingsPaneView.prototype.setExportUrl =	function()
{ 
	var
		sHref = '#',
		oBlob = null
	;

	this.downloadLinkHref(sHref);
	if (Blob && window.URL && $.isFunction(window.URL.createObjectURL))
	{
		if (JscryptoKey.getKey())
		{
			JscryptoKey.exportKey()
				.then(_.bind(function(keydata) {
					oBlob = new Blob([JSON.stringify(keydata)], {type: 'text/plain'});
					sHref = window.URL.createObjectURL(oBlob);
					this.downloadLinkHref(sHref);
				}, this));
		}
	}

};

CJscryptoSettingsPaneView.prototype.importKey = function ()
{
	$("#import-key-file").click();
};

CJscryptoSettingsPaneView.prototype.readKeyFromFile = function ()
{
	var 
		input = document.getElementById('import-key-file'),
		file = input.files[0],
		reader = new FileReader(),
		sContents = ''
	;

	if (!file)
	{
		Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_IMPORT_KEY'));
		return;
	}

	reader.onload = function(e)
	{
		sContents = e.target.result;
		JscryptoKey.importKeyFromString(sContents);
	};
	
	reader.readAsText(file);
};

CJscryptoSettingsPaneView.prototype.generateNewKey = function ()
{
	JscryptoKey.generateKey();
};

/**
 * @param {Object} oKey
 */
CJscryptoSettingsPaneView.prototype.removeJscryptoKey = function ()
{
	var
		sConfirm = '',
		fRemove = _.bind(function (bRemove) {
			if (bRemove)
			{
				var oRes = JscryptoKey.deleteKey();
				if (oRes.error)
				{
					Screens.showError(TextUtils.i18n('%MODULENAME%/ERROR_DELETE_KEY'));
				}
			}
		}, this)
	;
	
	sConfirm = TextUtils.i18n('%MODULENAME%/CONFIRM_DELETE_KEY');
	Popups.showPopup(ConfirmPopup, [sConfirm, fRemove]);
};

CJscryptoSettingsPaneView.prototype.getCurrentValues = function ()
{
	return [
		this.enableJscrypto()
	];
};

CJscryptoSettingsPaneView.prototype.revertGlobalValues = function ()
{
	this.enableJscrypto(Settings.enableJscrypto());
};

CJscryptoSettingsPaneView.prototype.getParametersForSave = function ()
{
	return {
		'EnableJscrypto': this.enableJscrypto()
	};
};

CJscryptoSettingsPaneView.prototype.applySavedValues = function (oParameters)
{
	Settings.update(oParameters.EnableJscrypto);
};

module.exports = new CJscryptoSettingsPaneView();
