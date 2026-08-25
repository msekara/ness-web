'use strict';
const p = require('../lib/protocol');

let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fails++; };

// Encode checksums must match the spec's worked examples.
ok('status request "S00" checksum = E9', p.statusRequest(0).includes('E9?'));
ok('arm "A123E" checksum = 7E',          p.arm('123').includes('7E?'));

// Status responses (spec "FORM 4" examples).
ok('zone 7 unsealed',  JSON.stringify(p.decode('8207036000400013').zones) === '[7]');
ok('zones 7 & 8',      JSON.stringify(p.decode('8207036000c00054').zones) === '[7,8]');
ok('zone 16 unsealed', JSON.stringify(p.decode('8207036000008094').zones) === '[16]');
ok('zone 1 in alarm',  (() => { const d = p.decode('820703600501000e'); return d.name === 'Zone in Alarm' && JSON.stringify(d.zones) === '[1]'; })());

// Event with timestamp (spec "Duress" example, decimal timestamp fields).
const e = p.decode('870203610201840612010743008D');
ok('event = Alarm',        e.eventName === 'Alarm');
ok('event area = Duress',  e.areaName === 'Duress');
ok('timestamp minute 43',  e.timestamp.minute === 43);
ok('timestamp month 12',   e.timestamp.month === 12);

// FORM 21 arming, FORM 22 outputs, version.
const a = p.decode('820003600e050000');
ok('arming Area 1 armed+fully', a.flags.includes('Area 1 Armed') && a.flags.includes('Area 1 Fully Armed'));
const o = p.decode('820003600f010000');
ok('output Siren Loud',  o.flags.includes('Siren Loud'));
const v = p.decode('8200036011002400');
ok('version D16X 2.4',   v.model === 'D16X' && v.version === '2.4');

console.log(fails ? `\n${fails} test(s) FAILED` : '\nAll tests passed');
process.exitCode = fails ? 1 : 0;
