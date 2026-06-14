import {TeslaApi} from '../TeslaApi.js';

const ACCESS_TOKEN = '123456789abcdef'; // Replace with your actual access token
const VEHICLE_ID = '1234567890'; // Replace with your actual vehicle ID

const api = new TeslaApi(ACCESS_TOKEN, VEHICLE_ID);
api.getVehicle().then(console.log);
