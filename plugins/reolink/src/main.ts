import { sleep } from '@scrypted/common/src/sleep';
import sdk, { Camera, DeviceCreatorSettings, DeviceInformation, MediaObject, PictureOptions, ScryptedInterface, Setting } from "@scrypted/sdk";
import { EventEmitter } from "stream";
import { Destroyable, RtspProvider, RtspSmartCamera, UrlMediaStreamOptions } from "../../rtsp/src/rtsp";
import { ReolinkCameraClient } from './reolink-api';

const { mediaManager } = sdk;

class ReolinkCamera extends RtspSmartCamera implements Camera {
    client: ReolinkCameraClient;

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);

        this.updateManagementUrl();
    }

    updateManagementUrl() {
        const ip = this.storage.getItem('ip');
        if (!ip)
            return;
        const info = this.info || {};
        const managementUrl = `http://${ip}`;
        if (info.managementUrl !== managementUrl) {
            info.managementUrl = managementUrl;
            this.info = info;
        }
    }

    getClient() {
        if (!this.client)
            this.client = new ReolinkCameraClient(this.getHttpAddress(), this.getUsername(), this.getPassword(), this.getRtspChannel(), this.console);
        return this.client;
    }

    async listenEvents() {
        const client = this.getClient();
        let killed = false;
        const events = new EventEmitter();
        const ret: Destroyable = {
            on: function (eventName: string | symbol, listener: (...args: any[]) => void): void {
                events.on(eventName, listener);
            },
            destroy: function (): void {
                killed = true;
            },
            emit: function (eventName: string | symbol, ...args: any[]): boolean {
                return events.emit(eventName, ...args);
            }
        };

        (async () => {
            while (!killed) {
                try {
                    const { value, data } = await client.getMotionState();
                    this.motionDetected = value;
                    ret.emit('data', data);
                }
                catch (e) {
                    ret.emit('error', e);
                }
                await sleep(1000);
            }
        })();
        return ret;
    }

    async takeSmartCameraPicture(option?: PictureOptions): Promise<MediaObject> {
        return this.createMediaObject(await this.getClient().jpegSnapshot(), 'image/jpeg');
    }

    async getUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'rtspChannel',
                title: 'Channel Number Override',
                subgroup: 'Advanced',
                description: "The channel number to use for snapshots and video. E.g., 0, 1, 2, etc.",
                placeholder: '0',
                type: 'number',
                value: this.getRtspChannel(),
            },
            ...await super.getUrlSettings(),
        ]
    }

    getRtspChannel() {
        return parseInt(this.storage.getItem('rtspChannel')) || 0;
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = super.createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const ret: UrlMediaStreamOptions[] = [];

        const rtmpPreviews = [
            `main.bcs`,
            `ext.bcs`,
            `sub.bcs`,
        ];
        for (const preview of rtmpPreviews) {
            const url = new URL(`rtmp://${this.getRtmpAddress()}/bcs/channel${this.getRtspChannel()}_${preview}`);
            const params = url.searchParams;
            params.set('channel', this.getRtspChannel().toString());
            params.set('stream', '0');
            params.set('user', this.getUsername());
            params.set('password', this.getPassword());
            ret.push({
                name: `RTMP ${preview}`,
                id: preview,
                url: url.toString(),
            });
        }

        const channel = (this.getRtspChannel() + 1).toString().padStart(2, '0');
        const rtspPreviews = [
            `h264Preview_${channel}_main`,
            `h264Preview_${channel}_sub`,
            `h265Preview_${channel}_main`,
        ];
        for (const preview of rtspPreviews) {
            ret.push({
                name: `RTSP ${preview}`,
                id: preview,
                url: `rtsp://${this.getRtspAddress()}/${preview}`,
                container: 'rtsp',
                video: {
                    codec: preview.substring(0, 4),
                },
            });
        }

        return ret;
    }

    async putSetting(key: string, value: string) {
        this.client = undefined;
        super.putSetting(key, value);
        this.updateManagementUrl();
    }

    showRtspUrlOverride() {
        return false;
    }

    getRtspPortOverrideSettings(): Setting[] {
        if (!this.showRtspPortOverride()) {
            return [];
        }
        return [
            ...super.getRtspPortOverrideSettings(),
            {
                key: 'rtmpPort',
                subgroup: 'Advanced',
                title: 'RTMP Port Override',
                placeholder: '1935',
                value: this.storage.getItem('rtmpPort'),
            },
        ];
    }

    getRtmpAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('rtmpPort') || 1935}`;
    }
}

class ReolinkProider extends RtspProvider {
    getAdditionalInterfaces() {
        return [
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.Camera,
            ScryptedInterface.AudioSensor,
            ScryptedInterface.MotionSensor,
        ];
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const httpAddress = `${settings.ip}:${settings.httpPort || 80}`;
        let info: DeviceInformation = {};

        const username = settings.username?.toString();
        const password = settings.password?.toString();
        const skipValidate = settings.skipValidate === 'true';
        const rtspChannel = parseInt(settings.rtspChannel?.toString()) || 0;
        if (!skipValidate) {
            try {
                const api = new ReolinkCameraClient(httpAddress, username, password, rtspChannel, this.console);
                await api.jpegSnapshot();
                // there doesn't seem to be a way to get the actual model number information out of their api.
            }
            catch (e) {
                this.console.error('Error adding Reolink camera', e);
                throw e;
            }
        }
        settings.newCamera ||= 'Hikvision Camera';

        nativeId = await super.createDevice(settings, nativeId);

        const device = await this.getDevice(nativeId) as ReolinkCamera;
        device.info = info;
        device.putSetting('username', username);
        device.putSetting('password', password);
        device.setIPAddress(settings.ip?.toString());
        device.putSetting('rtspChannel', settings.rtspChannel?.toString());
        device.setHttpPortOverride(settings.httpPort?.toString());
        return nativeId;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'username',
                title: 'Username',
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
            },
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.2.222',
            },
            {
                key: 'rtspChannel',
                title: 'Channel Number Override',
                description: "Optional: The channel number to use for snapshots and video. E.g., 0, 1, 2, etc.",
                placeholder: '0',
                type: 'number',
            },
            {
                key: 'httpPort',
                title: 'HTTP Port',
                description: 'Optional: Override the HTTP Port from the default value of 80',
                placeholder: '80',
            },
            {
                key: 'skipValidate',
                title: 'Skip Validation',
                description: 'Add the device without verifying the credentials and network settings.',
                type: 'boolean',
            }
        ]
    }

    createCamera(nativeId: string) {
        return new ReolinkCamera(nativeId, this);
    }
}

export default ReolinkProider;
