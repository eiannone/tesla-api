import {request} from 'https';

const BASE_URL = "https://owner-api.teslamotors.com";

class ApiError extends Error {
    // Error reasons
    static UNKNOWN = 'Unknown';
    static UNAUTHORIZED = 'Unauthorized';
    static NO_VEHICLE = 'Vehicle not found';
    static IN_SERVICE = 'Vehicle in service';
    static UNAVAILABLE = 'Vehicle unavailable';
    static TIMEOUT = 'Timeout';
    static NETWORK = 'Network unavailable';
    static SERVER = 'Internal server error';
    static FORBIDDEN = 'Forbidden';

    constructor(error, reason = null) {
        super((error instanceof Error)? error.message : error);
        this.reason = reason || ApiError.UNKNOWN;
    }
    reason() { return this.reason; }
}

class TeslaApi {
    constructor(access_token = null, id = null, refresh_token = null) {
        this.vid = id;
        this.token = access_token;
        this.refresh_token = refresh_token;
        this.timeout = 10000;
    }

    setTimeout(seconds) {
        this.timeout = seconds * 1000;
    }

    #decodeStatus(statusCode) {
        switch(statusCode) { // https://developer.tesla.com/docs/fleet-api#response-codes
            case 401: return ApiError.UNAUTHORIZED;
            case 403: return ApiError.FORBIDDEN;
            case 404: return ApiError.NO_VEHICLE;
            case 405: return ApiError.IN_SERVICE;
            case 406: return ApiError.NETWORK; // Not Acceptable
            case 408: return ApiError.UNAVAILABLE;
            case 500: return ApiError.SERVER;
            case 502: return ApiError.NETWORK; // Bad gateway
            case 503: return ApiError.NETWORK; // Service unavailable
            case 504: return ApiError.TIMEOUT;
            case 540: return ApiError.UNAVAILABLE; // TODO: check. Should be system booting
            default:  return ApiError.UNKNOWN;
        }
    }

    async #apiCall(path = "", method = 'GET', params = undefined) {
        return new Promise((resolve, reject) => {
            const postData = (typeof params != 'undefined')? JSON.stringify(params) : '';
            let headers = { 'user-agent': "TeslaEma", 'Authorization': "Bearer " + this.token };
            if (postData.length > 0) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = postData.length;
            }

            const req = request(BASE_URL + "/api/1/vehicles/" + path, {
                headers: headers,
                timeout: this.timeout,
                method: method
            }, res => {
                if (res.statusCode > 199 && res.statusCode < 300) {
                    res.setEncoding('utf8');
                    let rawData = '';
                    res.on('data', chunk => { rawData += chunk; });
                    res.on('end', _ => {
                        try {
                            const json = JSON.parse(rawData);
                            resolve(json.response);
                        }
                        catch(err) {
                            reject(new ApiError(err));
                        }
                    });
                } else {
                    // if status code = 401 (unauthorized) the token could be expired
                    if (res.statusCode == 401 && this.refresh_token != null) {
                        // Tries to refresh the tokens
                        this.refreshToken(this.refresh_token)
                            .then(_ => this.#apiCall(path, method, params))
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                    let errMsg = res.statusMessage + " ("+res.statusCode+")";
                    reject(new ApiError(errMsg, this.#decodeStatus(res.statusCode)));
                }
            });
            req.on('error', e => {
                // Error code examples:
                // - EAI_AGAIN (DNS lookup timeout)
                // - ECONNRESET
                // - ECONNREFUSED
                // - ENOTFOUND
                reject(new ApiError(e.message + " ("+e.code+")", ApiError.NETWORK));
            });
            if (postData.length > 0) req.write(postData);
            req.end();
        });
    }

    async getVehicles() {
        return this.#apiCall();
    }

    async getVehicle(id = null) {
        return this.#apiCall((id == null)? this.vid : id);
    }

    /**
     * https://developer.tesla.com/docs/fleet-api#vehicle_data
     * Starting from firmware update 2023.38+, if you don't specify any endopint, the following ones are returned:
     * charge_state, climate_state, drive_state (without location), gui_settings, vehicle_config, vehicle_state
     * You can ask for the following specific endpoints:
     * charge_state, climate_state, closures_state, drive_state, gui_settings, location_data, vehicle_config, vehicle_state,
     * vehicle_data_combo
     */
    async getVehicleData(endpoints = [], id = null) {
        let path = ((id == null)? this.vid : id) + "/vehicle_data";
        if (endpoints.length > 0) path += "?endpoints="+endpoints.join('%3B');
        return this.#apiCall(path);
    }

    async wakeUp(id = null) {
        const vid = (id == null)? this.vid : id;
        return this.#apiCall(vid + "/wake_up", "POST");
    }

    async command(command, params = undefined, id = null) {
        const vid = (id == null)? this.vid : id;
        return this.#apiCall(vid + "/command/" + command, "POST", params);
    }

    async #oauthCall(params) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(params);
            const req = request('https://auth.tesla.com/oauth2/v3/token', {
                headers: { 
                    'user-agent': "TeslaEma",
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length
                },
                timeout: 30000,
                method: 'POST'
            }, res => {
                if (res.statusCode > 199 && res.statusCode < 300) {
                    res.setEncoding('utf8');
                    let rawData = '';
                    res.on('data', chunk => { rawData += chunk; });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(rawData));
                        } catch(err) {
                            reject(new ApiError(err));
                        }
                    });
                } else {
                    let errMsg = res.statusMessage + " ("+res.statusCode+")";
                    reject(new ApiError(errMsg, this.#decodeStatus(res.statusCode)));
                }
            });
            req.on('error', e => {
                // Error code examples:
                // - EAI_AGAIN (DNS lookup timeout)
                // - ECONNRESET
                // - ECONNREFUSED
                // - ENOTFOUND
                reject(new ApiError(e.message + " ("+e.code+")", ApiError.NETWORK));
            });
            req.write(postData);
            req.end();
        });
    }

    onTokenRefresh(callback) {
        this.cb_refreshToken = callback;
    }

    // https://tesla-api.timdorr.com/api-basics/authentication
    async refreshToken(refresh_token, retry = 1) {
        try {
            const oauth = await this.#oauthCall({
                grant_type: 'refresh_token',
                client_id: 'ownerapi',
                refresh_token,
                scope: 'openid email offline_access'
            });
            this.refresh_token = oauth.refresh_token;
            this.token = oauth.access_token;
            if (typeof this.cb_refreshToken == 'function') {
                this.cb_refreshToken(this.token, this.refresh_token);
            }
            return oauth;   
        }
        catch(error) {
            if (retry < 3) {
                await new Promise(resolve => setTimeout(resolve, 500));
                return this.refreshToken(refresh_token, retry + 1);
            }
            if (error instanceof Error) error.message += " - Unable to refresh Token";
            throw error;            
        }
    }

    async getId(vehicle_id) {
        return this.#apiCall().then(vehicles => {
            for (let v = 0; v < vehicles.length; v++) {
                if (!vehicles[v].hasOwnProperty('vehicle_id') || !vehicles[v].hasOwnProperty('id_s')) continue;
                if (vehicles[v].vehicle_id == vehicle_id) {
                    this.vid = vehicles[v].id_s;
                    return this.vid;
                }
            }
            throw new ApiError("Vehicle not found");
        });
    }
}

export { ApiError, TeslaApi }