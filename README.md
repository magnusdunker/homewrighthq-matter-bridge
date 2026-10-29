# Matter bridge for HomewrightHQ

An external integration for [HomewrightHQ](https://github.com/magnusdunker/homewrighthq) that shows the devices you pick to Apple Home, Google Home and Amazon Alexa as Matter devices. A Zigbee lamp, a Z-Wave thermostat or a Shelly relay can then be controlled with Siri, Google Assistant or Alexa, over the local network.

Matter lets one device belong to several apps at once, so the same bridge can be in Apple Home and Google Home together.

## Installation

Requires HomewrightHQ 0.5.36 or newer.

In HomewrightHQ: **Settings → Integrations → From GitHub**. Paste

```
https://github.com/magnusdunker/homewrighthq-matter-bridge
```

and press **Install**. Then add **Matter-bro** (Matter bridge) under **Add integration**, pick the devices, and save.

A notification then shows the pairing code and a QR code. In the app:

- **Apple Home:** + → Add Accessory, scan the QR code or choose More options and enter the code.
- **Google Home:** + → Device → Matter-enabled device.
- **Alexa:** + → Add Device → Other → Matter.

The app warns that the device is not certified. Choose to add it anyway (see [Not certified](#not-certified)).

To add the bridge to a second app, use the app's own "share" or "pairing mode" for the bridge, or call the action `matter_bridge.open_pairing`. It shows the code again.

## What it shows

| HomewrightHQ | Matter device | What the app can do |
|---|---|---|
| `light` | On/off, dimmable, colour temperature or extended colour light, from `supported_color_modes` | on, off, brightness, colour temperature, colour |
| `switch`, `input_boolean` | On/off plug-in unit | on, off |
| `fan` | Fan | on, off, speed in percent |
| `cover` | Window covering | open, close, stop, position (when the cover has positions) |
| `climate` | Thermostat (heating, and cooling when `hvac_modes` has `cool`) | target temperature, off, heat, cool |
| `sensor` with device class `temperature`, `humidity` or `illuminance` | Temperature, humidity or light sensor | read |
| `binary_sensor` with device class `door`, `window`, `opening` or `garage_door` | Contact sensor | read |
| `binary_sensor` with device class `motion`, `occupancy` or `presence` | Occupancy sensor | read |
| `binary_sensor` with device class `moisture` | Water leak detector | read |

Other entities are skipped with a line in the log. An entity that is unavailable in HomewrightHQ shows as not responding in the app.

Locks and alarm panels are not included. HomewrightHQ only lets an external integration control locks it owns itself, so that a plugin cannot open a door.

The bridge also adds the sensor **Parring** (pairing): `not_paired` or `paired`, with the pairing codes and the number of apps (fabrics) as attributes.

## Options

Under **Options** on the integration you can change the name, the devices and the UDP port (5540 by default). The bridge then restarts, and the app sees new and removed devices after a while. The pairing stays.

## Not certified

The bridge uses the Matter test vendor id (0xFFF1) and a test certificate, as uncertified Matter software does. That has these consequences:

- Apple Home asks for confirmation before it adds an uncertified accessory.
- Google Home only accepts a test device when the vendor and product id (0xFFF1 and 0x8000) are registered as a Matter integration in your own project in the Google Home Developer Console.
- Alexa's handling of uncertified devices has not been tried.

## Tested

The tests start the integration as HomewrightHQ does, pair a [matter.js](https://github.com/project-chip/matter.js) controller with it over UDP, and check that commands from the controller become HomewrightHQ actions and that states reach the controller. The release runs them against the compiled Linux binary too.

Not tried yet: pairing with Apple Home, Google Home and Alexa, and running inside HomewrightHQ's sandbox on a Raspberry Pi.

## Network

Matter uses UDP on the port above and mDNS (UDP 5353) to be found. HomewrightHQ in Docker needs host networking (`network_mode: host`), which the supplied `docker-compose.yml` uses. Thread is not needed: the bridge is reached over Wi-Fi or Ethernet.

## Development

```
npm install
npm test          # unit tests and the pairing test
npm run build     # a binary with Bun in dist/
```

`BRIDGE_BIN=dist/matter_bridge npm test` runs the pairing test against a built binary. `MATTER_LOG_LEVEL=DEBUG` shows matter.js's log.

The integration is written in JavaScript on [matter.js](https://github.com/project-chip/matter.js) and built into one binary per platform with Bun. `sdk/homewright-plugin.js` is the protocol with HomewrightHQ.

## License

MIT
