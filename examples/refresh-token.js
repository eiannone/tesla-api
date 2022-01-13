import {TeslaApi, ApiError} from '../TeslaApi.js';

const api = new TeslaApi();
api.refreshToken('1234')
    .then(result => console.log(JSON.stringify(result)))
    .catch(err => {
        let reason = (err instanceof ApiError)? err.reason : ApiError.UNKNOWN;
        const errMsg = (err instanceof Error)? err.message : err;
        console.error("ApiError " + reason + ": " + errMsg);
        process.exit(-1);
    });