/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as nls from 'vs/nls';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { Extensions, IViewDescriptorService, IViewsRegistry, IViewsService } from 'vs/workbench/common/views';
import { IActivityService, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { IRemoteExplorerService, MakeAddress, mapHasTunnelLocalhostOrAllInterfaces, TUNNEL_VIEW_ID } from 'vs/workbench/services/remote/common/remoteExplorerService';
import { forwardedPortsViewEnabled, ForwardPortAction, OpenPortInBrowserAction, TunnelPanelDescriptor, TunnelViewModel } from 'vs/workbench/contrib/remote/browser/tunnelView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { Registry } from 'vs/platform/registry/common/platform';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from 'vs/workbench/services/statusbar/common/statusbar';
import { UrlFinder } from 'vs/workbench/contrib/remote/browser/urlFinder';
import Severity from 'vs/base/common/severity';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { INotificationService, IPromptChoice } from 'vs/platform/notification/common/notification';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';

export const VIEWLET_ID = 'workbench.view.remote';

export class ForwardedPortsView extends Disposable implements IWorkbenchContribution {
	private contextKeyListener?: IDisposable;
	private _activityBadge?: IDisposable;
	private entryAccessor: IStatusbarEntryAccessor | undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteExplorerService private readonly remoteExplorerService: IRemoteExplorerService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IActivityService private readonly activityService: IActivityService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();
		this._register(Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViewWelcomeContent(TUNNEL_VIEW_ID, {
			content: `Forwarded ports allow you to access your running applications locally.\n[Forward a Port](command:${ForwardPortAction.INLINE_ID})`,
		}));
		this.enableBadgeAndStatusBar();
		this.enableForwardedPortsView();
	}

	private enableForwardedPortsView() {
		if (this.contextKeyListener) {
			this.contextKeyListener.dispose();
			this.contextKeyListener = undefined;
		}

		const viewEnabled: boolean = !!forwardedPortsViewEnabled.getValue(this.contextKeyService);
		if (this.environmentService.remoteAuthority && viewEnabled) {
			const tunnelPanelDescriptor = new TunnelPanelDescriptor(new TunnelViewModel(this.remoteExplorerService), this.environmentService);
			const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
			const viewContainer = this.viewDescriptorService.getViewContainerById(VIEWLET_ID);
			if (viewContainer) {
				viewsRegistry.registerViews([tunnelPanelDescriptor!], viewContainer);
			}
		} else if (this.environmentService.remoteAuthority) {
			this.contextKeyListener = this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(new Set(forwardedPortsViewEnabled.keys()))) {
					this.enableForwardedPortsView();
				}
			});
		}
	}

	private enableBadgeAndStatusBar() {
		this._register(this.remoteExplorerService.tunnelModel.onForwardPort(() => {
			this.updateActivityBadge();
			this.updateStatusBar();
		}));
		this._register(this.remoteExplorerService.tunnelModel.onClosePort(() => {
			this.updateActivityBadge();
			this.updateStatusBar();
		}));
		const disposable = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).onViewsRegistered(e => {
			if (e.find(view => view.views.find(viewDescriptor => viewDescriptor.id === TUNNEL_VIEW_ID))) {
				this.updateActivityBadge();
				this.updateStatusBar();
				disposable.dispose();
			}
		});
	}

	private updateActivityBadge() {
		if (this._activityBadge) {
			this._activityBadge.dispose();
		}
		if (this.remoteExplorerService.tunnelModel.forwarded.size > 0) {
			const viewContainer = this.viewDescriptorService.getViewContainerByViewId(TUNNEL_VIEW_ID);
			if (viewContainer) {
				this._activityBadge = this.activityService.showViewContainerActivity(viewContainer.id, {
					badge: new NumberBadge(this.remoteExplorerService.tunnelModel.forwarded.size, n => n === 1 ? nls.localize('1forwardedPort', "1 forwarded port") : nls.localize('nForwardedPorts', "{0} forwarded ports", n))
				});
			}
		}
	}

	private updateStatusBar() {
		if (!this.entryAccessor && this.remoteExplorerService.tunnelModel.forwarded.size > 0) {
			this._register(this.entryAccessor = this.statusbarService.addEntry(this.entry, 'status.forwardedPorts', nls.localize('status.forwardedPorts', "Forwarded Ports"), StatusbarAlignment.LEFT, 40));
		} else if (this.entryAccessor && this.remoteExplorerService.tunnelModel.forwarded.size === 0) {
			this.entryAccessor.dispose();
			this.entryAccessor = undefined;
		}
	}

	private get entry(): IStatusbarEntry {
		return {
			text: '$(radio-tower) ' + nls.localize('remote.forwardedPorts.statusbarText', "Application running"),
			ariaLabel: nls.localize('remote.forwardedPorts.statusbarAria', "Application running and available locally through port forwarding"),
			tooltip: nls.localize('remote.forwardedPorts.statusbarTooltip', "Application available locally (port forwarded)"),
			command: `${TUNNEL_VIEW_ID}.focus`
		};
	}
}


export class AutomaticPortForwarding extends Disposable implements IWorkbenchContribution {
	private contextServiceListener?: IDisposable;
	private urlFinder?: UrlFinder;
	private static AUTO_FORWARD_SETTING = 'remote.autoForwardPorts';

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IViewsService private readonly viewsService: IViewsService,
		@IRemoteExplorerService private readonly remoteExplorerService: IRemoteExplorerService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(AutomaticPortForwarding.AUTO_FORWARD_SETTING)) {
				this.tryStartStopUrlFinder();
			}
		}));

		if (this.environmentService.remoteAuthority) {
			this.contextServiceListener = this._register(this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(new Set(forwardedPortsViewEnabled.keys()))) {
					this.tryStartStopUrlFinder();
				}
			}));
			this.tryStartStopUrlFinder();
		}
	}

	private tryStartStopUrlFinder() {
		if (this.configurationService.getValue(AutomaticPortForwarding.AUTO_FORWARD_SETTING)) {
			this.startUrlFinder();
		} else {
			this.stopUrlFinder();
		}
	}

	private startUrlFinder() {
		if (!this.urlFinder && !forwardedPortsViewEnabled.getValue(this.contextKeyService)) {
			return;
		}
		if (this.contextServiceListener) {
			this.contextServiceListener.dispose();
		}
		this.urlFinder = this._register(new UrlFinder(this.terminalService));
		this._register(this.urlFinder.onDidMatchLocalUrl(async (localUrl) => {
			if (mapHasTunnelLocalhostOrAllInterfaces(this.remoteExplorerService.tunnelModel.forwarded, localUrl.host, localUrl.port)) {
				return;
			}
			const forwarded = await this.remoteExplorerService.forward(localUrl);
			if (forwarded) {
				const address = MakeAddress(forwarded.tunnelRemoteHost, forwarded.tunnelRemotePort);
				const message = nls.localize('remote.tunnelsView.automaticForward', "{0} from the remote has been forwarded to {1} locally.",
					address, forwarded.localAddress);
				const browserChoice: IPromptChoice = {
					label: OpenPortInBrowserAction.LABEL,
					run: () => OpenPortInBrowserAction.run(this.remoteExplorerService.tunnelModel, this.openerService, address)
				};
				const showChoice: IPromptChoice = {
					label: nls.localize('remote.tunnelsView.showView', "Show Forwarded Ports"),
					run: () => {
						const remoteAuthority = this.environmentService.remoteAuthority;
						const explorerType: string[] | undefined = remoteAuthority ? [remoteAuthority.split('+')[0]] : undefined;
						if (explorerType) {
							this.remoteExplorerService.targetType = explorerType;
						}
						this.viewsService.openViewContainer(VIEWLET_ID);
					}
				};
				this.notificationService.prompt(Severity.Info, message, [browserChoice, showChoice], { neverShowAgain: { id: 'remote.tunnelsView.autoForwardNeverShow', isSecondary: true } });
			}
		}));
	}

	private stopUrlFinder() {
		if (this.urlFinder) {
			this.urlFinder.dispose();
			this.urlFinder = undefined;
		}
	}
}
