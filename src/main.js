// Matter bridge for HomewrightHQ: a custom integration that shows the chosen
// entities to Apple Home, Google Home and Alexa as Matter devices.

import './stdout.js';
import './logs.js';
import { run } from '../sdk/homewright-plugin.js';
import { MatterBridgeIntegration } from './integration.js';

run(new MatterBridgeIntegration());
