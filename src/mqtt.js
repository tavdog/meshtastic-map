const crypto = require("crypto");
const path = require("path");
const mqtt = require("mqtt");
const protobufjs = require("protobufjs");

// create prisma db client
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// create mqtt client
const client = mqtt.connect("mqtt://mqtt.meshtastic.org", {
    username: "meshdev",
    password: "large4cats",
});

// load protobufs
const root = new protobufjs.Root();
root.resolvePath = (origin, target) => path.join(__dirname, "protos", target);
root.loadSync('meshtastic/mqtt.proto');
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");
const MapReport = root.lookupType("MapReport");
const NeighborInfo = root.lookupType("NeighborInfo");
const Position = root.lookupType("Position");
const RouteDiscovery = root.lookupType("RouteDiscovery");
const Telemetry = root.lookupType("Telemetry");
const User = root.lookupType("User");

function createNonce(packetId, fromNode) {

    // Expand packetId to 64 bits
    const packetId64 = BigInt(packetId);

    // Initialize block counter (32-bit, starts at zero)
    const blockCounter = 0;

    // Create a buffer for the nonce
    const buf = Buffer.alloc(16);

    // Write packetId, fromNode, and block counter to the buffer
    buf.writeBigUInt64LE(packetId64, 0);
    buf.writeUInt32LE(fromNode, 8);
    buf.writeUInt32LE(blockCounter, 12);

    return buf;

}

/**
 * References:
 * https://github.com/crypto-smoke/meshtastic-go/blob/develop/radio/aes.go#L42
 * https://github.com/pdxlocations/Meshtastic-MQTT-Connect/blob/main/meshtastic-mqtt-connect.py#L381
 */
function decrypt(packet) {
    try {

        // default encryption key
        const key = Buffer.from("1PG7OiApB1nwvP+rz05pAQ==", "base64");

        // create decryption iv/nonce for this packet
        const nonceBuffer = createNonce(packet.id, packet.from);

        // create aes-128-ctr decipher
        const decipher = crypto.createDecipheriv('aes-128-ctr', key, nonceBuffer);

        // decrypt encrypted packet
        const decryptedBuffer = Buffer.concat([decipher.update(packet.encrypted), decipher.final()]);

        // parse as data message
        return Data.decode(decryptedBuffer);

    } catch(e) {
        return null;
    }
}

// subscribe to everything when connected
client.on("connect", () => {
    client.subscribe("#");
});

// handle message received
client.on("message", async (topic, message) => {
    try {

        // decode service envelope
        const envelope = ServiceEnvelope.decode(message);

        // attempt to decrypt encrypted packets
        const isEncrypted = envelope.packet.encrypted?.length > 0;
        if(isEncrypted){
            const decoded = decrypt(envelope.packet);
            if(decoded){
                envelope.packet.decoded = decoded;
            }
        }

        const logKnownPacketTypes = false;
        const logUnknownPacketTypes = true;
        const portnum = envelope.packet?.decoded?.portnum;

        if(portnum === 3) {

            const position = Position.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes){
                console.log("POSITION_APP", {
                    from: envelope.packet.from.toString(16),
                    position: position,
                });
            }

            // update node position in db
            if(position.latitudeI != null && position.longitudeI){
                try {
                    await prisma.node.updateMany({
                        where: {
                            node_id: envelope.packet.from,
                        },
                        data: {
                            latitude: position.latitudeI,
                            longitude: position.longitudeI,
                            altitude: position.altitude !== 0 ? position.altitude : null,
                        },
                    });
                } catch (e) {
                    console.error(e);
                }
            }

        }

        else if(portnum === 4) {

            const user = User.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes) {
                console.log("NODEINFO_APP", {
                    from: envelope.packet.from.toString(16),
                    user: user,
                });
            }

            // create or update node in db
            try {
                await prisma.node.upsert({
                    where: {
                        node_id: envelope.packet.from,
                    },
                    create: {
                        node_id: envelope.packet.from,
                        long_name: user.longName,
                        short_name: user.shortName,
                        hardware_model: user.hwModel,
                        is_licensed: user.isLicensed === true,
                        role: user.role,
                    },
                    update: {
                        long_name: user.longName,
                        short_name: user.shortName,
                        hardware_model: user.hwModel,
                        is_licensed: user.isLicensed === true,
                        role: user.role,
                    },
                });
            } catch (e) {
                console.error(e);
            }

        }

        else if(portnum === 71) {

            const neighbourInfo = NeighborInfo.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes) {
                console.log("NEIGHBORINFO_APP", {
                    from: envelope.packet.from.toString(16),
                    neighbour_info: neighbourInfo,
                });
            }

            try {
                await prisma.neighbourInfo.create({
                    data: {
                        node_id: envelope.packet.from,
                        node_broadcast_interval_secs: neighbourInfo.nodeBroadcastIntervalSecs,
                        neighbours: neighbourInfo.neighbors.map((neighbour) => {
                            return {
                                node_id: neighbour.nodeId,
                                snr: neighbour.snr,
                            };
                        }),
                    },
                });
            } catch (e) {
                console.error(e);
            }

        }

        else if(portnum === 67) {

            const telemetry = Telemetry.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes) {
                console.log("TELEMETRY_APP", {
                    from: envelope.packet.from.toString(16),
                    telemetry: telemetry,
                });
            }

            // data to update
            const data = {};

            // handle device metrics
            if(telemetry.deviceMetrics){
                data.battery_level = telemetry.deviceMetrics.batteryLevel !== 0 ? telemetry.deviceMetrics.batteryLevel : null;
                data.voltage = telemetry.deviceMetrics.voltage !== 0 ? telemetry.deviceMetrics.voltage : null;
                data.channel_utilization = telemetry.deviceMetrics.channelUtilization !== 0 ? telemetry.deviceMetrics.channelUtilization : null;
                data.air_util_tx = telemetry.deviceMetrics.airUtilTx !== 0 ? telemetry.deviceMetrics.airUtilTx : null;
            }

            // update node telemetry in db
            if(Object.keys(data).length > 0){
                try {
                    await prisma.node.updateMany({
                        where: {
                            node_id: envelope.packet.from,
                        },
                        data: data,
                    });
                } catch (e) {
                    console.error(e);
                }
            }

        }

        else if(portnum === 70) {

            const routeDiscovery = RouteDiscovery.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes) {
                console.log("TRACEROUTE_APP", {
                    from: envelope.packet.from.toString(16),
                    route_discovery: routeDiscovery,
                });
            }

            try {
                await prisma.traceRoute.create({
                    data: {
                        node_id: envelope.packet.from,
                        route: routeDiscovery.route,
                    },
                });
            } catch (e) {
                console.error(e);
            }

        }

        else if(portnum === 73) {

            const mapReport = MapReport.decode(envelope.packet.decoded.payload);

            if(logKnownPacketTypes) {
                console.log("MAP_REPORT_APP", {
                    from: envelope.packet.from.toString(16),
                    map_report: mapReport,
                });
            }

            try {
                await prisma.mapReport.create({
                    data: {
                        node_id: envelope.packet.from,
                        long_name: mapReport.longName,
                        short_name: mapReport.shortName,
                        role: mapReport.role,
                        hardware_model: mapReport.hwModel,
                        firmware_version: mapReport.firmwareVersion,
                        region: mapReport.region,
                        modem_preset: mapReport.modemPreset,
                        has_default_channel: mapReport.hasDefaultChannel,
                        latitude: mapReport.latitudeI,
                        longitude: mapReport.longitudeI,
                        altitude: mapReport.altitude,
                        position_precision: mapReport.positionPrecision,
                        num_online_local_nodes: mapReport.numOnlineLocalNodes,
                    },
                });
            } catch (e) {
                console.error(e);
            }

        }

        else {
            if(logUnknownPacketTypes){

                // ignore packets we don't want to see for now
                if(portnum === undefined // ignore failed to decrypt
                    || portnum === 1 // ignore TEXT_MESSAGE_APP
                    || portnum === 5 // ignore ROUTING_APP
                    || portnum === 34 // ignore PAXCOUNTER_APP
                    || portnum === 65 // ignore STORE_FORWARD_APP
                    || portnum === 66 // ignore RANGE_TEST_APP
                ){
                    return;
                }

                console.log(portnum, envelope);

            }
        }

    } catch(e) {
        // ignore errors
    }
});