import {TeslaApi, ApiError} from '../TeslaApi.js';

const api = new TeslaApi('eu-abcde');
api.getId('1234').then(console.log);