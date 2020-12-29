# Nodejs Tesla API

## Install

```
$ npm install @eiannone/tesla-api
```

## Usage

```js
const api = new TeslaApi(access_token);

// https://www.teslaapi.io/vehicles/list#vehicles
api.getVehicles()
    .then(vehicles => {
        vehicles.forEach(v => {
            console.log(v.display_name+": id="+v.id+", stream_id="+v.vehicle_id+", state="+v.state);
        });
    })
    .catch((err) => {
        let reason = (err instanceof ApiError)? err.reason : ApiError.UNKNOWN;
        const errMsg = (err instanceof Error)? err.message : err;
        console.error("ApiError [" + reason + "]: " + errMsg);
        process.exit(-1);
    });
```
