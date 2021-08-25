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

    constructor(error, reason = null) {
        super((error instanceof Error)? error.message : error);
        this.reason = reason || ApiError.UNKNOWN;
    }
    reason() { return this.reason; }
}

class TeslaApi {
    constructor(access_token = null, vehicle_id = null, refresh_token = null) {
        this.vid = vehicle_id;
        this.token = access_token;
        this.refresh_token = refresh_token;
    }

    #decodeStatus(statusCode) {
        switch(statusCode) {
            case 401: return ApiError.UNAUTHORIZED;
            case 404: return ApiError.NO_VEHICLE;
            case 405: return ApiError.IN_SERVICE;
            case 408: return ApiError.UNAVAILABLE;
            case 500: return ApiError.SERVER;
            case 503: return ApiError.NETWORK;
            case 504: return ApiError.TIMEOUT;
            case 540: return ApiError.UNAVAILABLE; // TODO: check. Should be system booting
            default: return ApiError.UNKNOWN;
        }
    }

    async #apiCall(path, method = 'GET') {
        return new Promise((resolve, reject) => {       
            const req = request(BASE_URL + "/api/1/vehicles/" + path, {
                headers: { 'user-agent': "TeslaEma", 'Authorization': "Bearer " + this.token },
                timeout: 30000,
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
                            .then(_ => this.#apiCall(path, method))
                            .then(response => resolve(response))
                            .catch(error => { reject(error); });
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
            req.end();
        });
    }

    async getVehicles() {
        return this.#apiCall("");
    }

    async getVehicle(vehicle_id = null) {
        return this.#apiCall((vehicle_id == null)? this.vid : vehicle_id);
    }

    async getVehicleData(vehicle_id = null) {
        const vid = (vehicle_id == null)? this.vid : vehicle_id;
        return this.#apiCall(vid + "/vehicle_data");
    }

    async getChargeState(vehicle_id = null) {
        const vid = (vehicle_id == null)? this.vid : vehicle_id;
        return this.#apiCall(vid + "/data_request/charge_state");
    }    

    async wakeUp(vehicle_id = null) {
        const vid = (vehicle_id == null)? this.vid : vehicle_id;
        return this.#apiCall(vid + "/wake_up", "POST");
    }

    async command(command, vehicle_id = null) {
        const vid = (vehicle_id == null)? this.vid : vehicle_id;
        return this.#apiCall(vid + "/command/" + command, "POST");
    }

    async #oauthCall(params) {
        const post_data = JSON.stringify(params);
        return new Promise((resolve, reject) => {
            const req = request(BASE_URL + '/oauth/token', {
                headers: { 
                    'user-agent': "TeslaEma",
                    'Content-Type': 'application/json',
                    'Content-Length': post_data.length
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
            req.write(post_data);
            req.end();
        });s
    }

    onTokenRefreh(callback) {
        this.cb_refreshToken = callback;
    }

    async refreshToken(refresh_token) {
        return this.#oauthCall({'grant_type': "refresh_token", 'refresh_token': refresh_token})
            .then(async (resp) => {
                this.token = resp.access_token;
                this.refresh_token = resp.refresh_token;
                if (typeof this.cb_refreshToken == 'function') {
                    this.cb_refreshToken(this.token, this.refresh_token);
                }
                return resp;
            })
            .catch(error => {
                if (error instanceof Error) error.message += " - Unable to refresh Token";
                throw error;
            });
    }

    async getTokens(email, password) {
        return this.#oauthCall({
            'grant_type': "password",
            'email': email,
            'password': password,
            'client_id': "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384",
            'client_secret': "c7257eb71a564034f9419ee651c7d0e5f7aa6bfbd18bafb5c5c033b093bb2fa3"
        });
    }
}

export { ApiError, TeslaApi }