import WebSocket from 'ws';
import {EventEmitter} from 'events';

const CONNECTING = 1;
const CONNECTED = 2;
const CLOSING = 3;
const CLOSED = 4;

export default class TeslaStream extends EventEmitter {
    static DEFAULT_COLUMNS = ['elevation', 'est_heading', 'est_lat', 'est_lng', 'odometer', 'power', 'shift_state', 'speed', 'soc'];

    constructor(logger = null) {
        super();
        this.log = logger || this.#internalLog;
        this.ws = null;
        this.state = CLOSED;
        this.columns = TeslaStream.DEFAULT_COLUMNS;
        this.checkTimeout = null;
        this.timeouts = 0;
        this.disconnects = 0;
        this.reconnect = true;
        this.tag = null;
        this.lastShiftState = null;
    }

    isConnected() {
        return this.state == CONNECTED;
    }

    isClosed() {
        return this.state == CLOSED;
    }

    isClosing() {
        return this.state == CLOSING;
    }    

    #internalLog(msg, level = 'debug') {
        console.log("[%s] %s", level, msg);
    }

    #expBackOffMs(exp, minSeconds, maxSeconds, base = 2) {
        let ms = Math.max(Math.pow(base, exp), minSeconds);
        return Math.round(Math.min(ms, maxSeconds) * 1000);
    }

    disconnect(reconnect = false, unsubscribe = true) {
        if (this.state == CLOSED) return;
        this.reconnect = reconnect;
        if (this.checkTimeout != null) {
            clearTimeout(this.checkTimeout);
            this.checkTimeout = null;
        }
        if (this.ws == null || this.ws.readyState == WebSocket.CLOSED) {
            this.ws = null;
            this.state = CLOSED;
            return;
        }
        if (this.ws.readyState == WebSocket.CONNECTING) {
            this.ws.removeAllListeners('open');
            this.ws.on('open', _ => { disconnect(reconnect, unsubscribe); });
            return;
        }
        this.state = CLOSING;
        if (this.ws.readyState != WebSocket.CLOSING) {
            if (unsubscribe) {
                this.log("Unsubscribing...");
                this.ws.send(JSON.stringify({msg_type: "data:unsubscribe", tag: this.tag}));
            }
            this.log("Sending closing frame...");
            this.ws.close(); // After closing eventually it will reconnect (see 'on close' event)
        }
    }

    #reconnect() {
        this.log("Disconnecting and reconnecting...");
        this.disconnect(true, false);
    }

    #timeout() {
        this.timeouts += 1;
        let level = (this.timeouts < 8)? 'debug' : 'info';
        this.log("Stream connection timed out / " + this.timeouts, level);        
        if (this.timeouts % 3 == 0) { // Teslamate does it every 5th attempt
            this.log("Stream inactive!");
            this.emit('inactive');
        }
        this.#reconnect();
    }

    #subscribe(tag, token) {
        this.log("Subscribing to stream...");
        this.ws.send(JSON.stringify({
            msg_type: "data:subscribe_oauth",
            token: token,
            value: this.columns.join(','),
            tag: tag
        }));        
    }

    #disconnectResubscribe(tag, token, reason, minDelay) {
        this.disconnects++;
        this.log(reason + ((this.disconnects == 1)? '' : ' / '+this.disconnects), (this.disconnects < 8)? 'debug' : 'info');
        clearTimeout(this.checkTimeout);
        if (this.disconnects % 10 == 0) {
            this.log("Too many disconnects!", "warn");
            this.emit('too-many-disconnects');
        }
        else {
            const ms = (this.lastShiftState != null && this.lastShiftState != "")?
                this.#expBackOffMs(this.disconnects, 0, 8, 1.3) :
                this.#expBackOffMs(this.disconnects, minDelay, 120); // Teslamate uses min 15, max 30
            this.log("Waiting for " + Math.round(ms / 1000) + " sec...");                            
            this.checkTimeout = setTimeout(_ => { this.#subscribe(tag, token); }, ms);
        }        
    }

    connect(tag, token, columns = null, resubscribeDelay = 30) {
        this.tag = tag.toString();
        if (columns != null) this.columns = columns;        
        let shiftStatePos = this.columns.indexOf('shift_state');

        if (this.ws != null) {
            if (this.state == CLOSING) this.reconnect = true;
            if (this.ws.readyState != WebSocket.CLOSED) return;
        }
        this.state = CONNECTING;
        this.log("Connecting to websocket...");
        this.ws = new WebSocket("wss://streaming.vn.teslamotors.com/streaming/", {
            perMessageDeflate: false,
            handshakeTimeout: 6000,
            skipUTF8Validation: true
        });
        if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
        this.checkTimeout = setTimeout(this.#timeout.bind(this), this.#expBackOffMs(this.timeouts, 10, 30));

        this.ws.on('open', _ => {
            this.log("Websocket open.");
            this.#subscribe(this.tag, token);
        });
        this.ws.on('message', (message) => {
            if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
            this.checkTimeout = setTimeout(this.#timeout.bind(this), 15000);
            
            let d = JSON.parse(message);
            if (d.msg_type == 'control:hello') {
                this.log("Hello response received.");
                this.state = CONNECTED;
            } else if (d.msg_type == 'data:update') {
                let values = d.value.split(",");
                this.emit('stream', values);
                this.timeouts = 0;
                this.disconnects = 0;
                if (shiftStatePos > -1) this.lastShiftState = values[shiftStatePos + 1];
            } else if (d.msg_type == 'data:error' && typeof d.error_type != "undefined") {
                switch(d.error_type) {
                    case "vehicle_disconnected":
                        this.#disconnectResubscribe(tag, token, "Vehicle disconnected", resubscribeDelay);
                        break;
                    case "vehicle_error":
                        if (d.value == 'Vehicle is offline') this.emit('offline');
                        this.#disconnectResubscribe(tag, token, "Vehicle error: " + d.value, resubscribeDelay);
                        break;
                    case "client_error":
                        this.log("Client error: " + d.value, "error");
                        this.emit('error', d.value);
                        this.#reconnect();
                        break;
                    default:
                        this.log("Stream API error ["+d.error_type+"]: " + data, "error");
                        break;
                }                
            } else {
                this.log("Unknown message: " + message, "error");
                this.emit('error', message);
            }
        });
        this.ws.on('error', error => {
            const errMsg = (error instanceof Error)? error.message : error;
            this.log("Websocket error: " + errMsg, "error");
        });
        this.ws.on('close', (code, reason) => {
            this.log("Websocket closed ("+ code + (reason? ': ' + reason : '') + ").");
            if (code == 1006 && this.state != CLOSING) this.reconnect = true; // Abnormal close
            if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
            this.ws = null;
            this.state = CLOSED;
            if (this.reconnect) {
                this.checkTimeout = setTimeout(_ => { 
                    this.log("Reconnecting...");
                    this.connect(tag, token, columns); 
                }, 1000);
            }
        });
    }
}