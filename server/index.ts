declare var global: {
    Olm: any
    localStorage?: any
    atob: (string) => string;
};

// import * as request from "request-promise";
import {RequestPromise, RequestPromiseOptions} from "request-promise";
import cors from 'cors';
import express, {Request, Response} from "express";
import bodyParser from 'body-parser';
import * as mkdirp from "mkdirp";

import {RequestAPI, RequiredUriUrl} from "request";
// import sqlite3 from 'sqlite3';

// const indexeddbjs = require('indexeddb-js');
const Queue = require('better-queue');
const SqliteStore = require('better-queue-sqlite');
const request = require('request-promise');

const LocalStorageCryptoStore = require('matrix-js-sdk/lib/crypto/store/localStorage-crypto-store').default;

// create directory which will house the 3 stores.
mkdirp.sync('./store');
// Loading localStorage module
if (typeof global.localStorage === "undefined" || global.localStorage === null)
    global.localStorage = new (require('node-localstorage').LocalStorage)('./store/localStorage');

// import Olm before importing js-sdk to prevent it crying
global.Olm = require('olm');

import {
    Room,
    Event,
    Matrix,
    MatrixEvent,
    createClient,
    MatrixClient,
    IndexedDBStore,
    EventWithContext,
    MatrixInMemoryStore,
    IndexedDBCryptoStore,
    setCryptoStoreFactory,
    WebStorageSessionStore,
} from 'matrix-js-sdk';

const utils = require('matrix-js-sdk/src/utils');

let indexedDB;

// const engine = new sqlite3.Database('./store/indexedb.sqlite');
// const scope = indexeddbjs.makeScope('sqlite3', engine);
// indexedDB = scope.indexedDB;

if (indexedDB) {
    // setCryptoStoreFactory(() => new IndexedDBCryptoStore(indexedDB, 'matrix-js-sdk:crypto'));
    // setCryptoStoreFactory(() => new IndexedDBCryptoStore(null));
} else {
    setCryptoStoreFactory(() => new LocalStorageCryptoStore(global.localStorage));
}


class BleveHttp {
    request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>;

    constructor(baseUrl: string) {
        this.request = request.defaults({
            baseUrl,
        });
    }

    search(req: BleveRequest){
        return this.request({
            url: 'query',
            method: 'POST',
            json: true,
            body: req,
        });
    }

    index(events: Event[]) {
        return this.request({
            url: 'index',
            method: 'PUT',
            json: true,
            body: events,
        });
    }
}

const b = new BleveHttp("http://localhost:9999/api/");

const q = new Queue(async (batch: Event[], cb) => {
    console.log(batch);
    try {
        cb(null, await b.index(batch));
    } catch (e) {
        cb(e);
    }
}, {
    batchSize: 100,
    maxRetries: 10,
    retryDelay: 1000,
    store: new SqliteStore({
        path: './store/queue.sqlite',
    }),
    filter: (event: MatrixEvent, cb) => {
        if (event.getType() !== 'm.room.message') return cb('not m.room.message');
        return cb(null, event.event);
    }
});

q.on('task_accepted', function(taskId: string, ev: Event) {
    console.info(`Enqueue event ${ev.room_id}/${ev.event_id} ${ev.sender} [${ev.type}] (${taskId})`);
});

q.on('batch_failed', function(err) {
    console.error("[ERROR] Batch failed: ", err);
});

setup().then(console.log).catch(console.error);

declare global {
    interface Set<T> {
        intersect<T>(s: Set<T>): Set<T>;
        union<T>(s: Set<T>): Set<T>;
    }
}

Set.prototype.intersect = function<T>(s: Set<T>): Set<T> {
    return new Set<T>([...this].filter(x => s.has(x)));
};
Set.prototype.union = function<T>(s: Set<T>): Set<T> {
    return new Set<T>([...this, ...s]);
};

class GroupValue {
    public order: number|undefined;
    public nextBatch: string;
    public results: Array<string>;

    constructor() {
        this.order = undefined;
        this.nextBatch = "";
        this.results = [];
    }

    add(eventId: string, order: number) {
        if (this.order === undefined) this.order = order;
        this.results.push(eventId);
    }
}

class Batch {
    public Token: number;
    public Group: string;
    public GroupKey: string;

    constructor(Token: number = 0, Group: string, GroupKey: string) {
        this.Token = Token;
        this.Group = Group;
        this.GroupKey = GroupKey;
    }

    static fromString(from: string): Batch | undefined {
        try {
            const o = JSON.parse(from);
            // const b = new Batch(o);
        } catch (e) {
            return undefined;
        }
    }

    from() {
        return this.Token;
    }

    toString() {
        return JSON.stringify({
            Token: this.Token,
            Group: this.Group,
            GroupKey: this.GroupKey,
        });
    }
}

interface Query {
    must: Map<string, Array<string>>;
    mustNot: Map<string, Array<string>>;
}

interface BleveRequest {
    keys: Array<string>;
    filter: Query;
    sortBy: SearchOrder;
    searchTerm: string;
    from: number;
    size: number;
}

const pageSize = 10;

interface BleveResponseRow {
    roomId: string;
    eventId: string;
    score: number;
    highlights: Set<string>;
}

interface BleveResponse {
    rows: Array<BleveResponseRow>;
    total: number;
}

interface EventLookupContext {
    start: string;
    end: string;
    eventsBefore: Array<MatrixEvent>;
    eventsAfter: Array<MatrixEvent>;
    state: Array<MatrixEvent>;
}

interface EventLookupResult {
    event: MatrixEvent;
    score: number;
    context: EventLookupContext | null;
    highlights: Set<string>;
}

interface Result {
    rows: Array<BleveResponseRow>;
    lookup: Array<EventLookupResult>;
    total: number;
}

MatrixClient.prototype.fetchEvent = async function(roomId: string, eventId: string): Promise<MatrixEvent> {
    const path = utils.encodeUri('/rooms/$roomId/event/$eventId', {
        $roomId: roomId,
        $eventId: eventId,
    });

    let res;
    try {
        res = await this._http.authedRequest(undefined, 'GET', path);
    } catch (e) {}

    if (!res || !res.event)
        throw new Error("'event' not in '/event' result - homeserver too old?");

    return this.getEventMapper()(res.event);
};

// "dumb" mapper because e2e should be decrypted in browser, so we don't lose verification status
function mapper(cli: MatrixClient, plainOldJsObject: Event): MatrixEvent {
    return new MatrixEvent(plainOldJsObject);
}

// XXX: use getEventTimeline once we store rooms properly
MatrixClient.prototype.fetchEventContext = async function(roomId: string, eventId: string): Promise<EventWithContext> {
    const path = utils.encodeUri('/rooms/$roomId/context/$eventId', {
        $roomId: roomId,
        $eventId: eventId,
    });

    let res;
    try {
        res = await this._http.authedRequest(undefined, 'GET', path);
    } catch (e) {}

    if (!res || !res.event)
        throw new Error("'event' not in '/event' result - homeserver too old?");

    // const mapper = this.getEventMapper();

    const event = mapper(this, res.event);

    const state = utils.map(res.state, mapper);
    const events_after = utils.map(res.events_after, mapper);
    const events_before = utils.map(res.events_before, mapper);

    return {
        event,
        context: {
            state,
            events_after,
            events_before,
        },
    };
};

class Search {
    cli: MatrixClient;

    constructor(cli: MatrixClient) {
        this.cli = cli;
    }

    // impedance matching.
    async resolveOne(roomId: string, eventId: string, context?: RequestEventContext): Promise<EventWithContext> {
        if (context)
            return await this.cli.fetchEventContext(roomId, eventId);

        return {
            event: await this.cli.fetchEvent(roomId, eventId),
        };
    }

    // keep context as a map, so the whole thing can just be nulled.
    async resolve(rows: Array<BleveResponseRow>, context?: RequestEventContext): Promise<Array<EventLookupResult>> {
        return [];
    }

    // keys: pass straight through to go-bleve
    // searchFilter: compute and send search rules to go-bleve
    // roomIDsSet: used with above /\
    // sortBy: pass straight through to go-bleve
    // searchTerm: pass straight through to go-bleve
    // from: pass straight through to go-bleve
    // context: branch on whether or not to fetch context/events (js-sdk only supports context at this time iirc)
    async query(keys: Array<string>, searchFilter: Filter, sortBy: SearchOrder, searchTerm: string, from: number, context?: RequestEventContext): Promise<Result> {
        const filter: Query = {
            mustNot: new Map(),
            must: new Map(),
        };

        // must satisfy room_id
        if (searchFilter.rooms.size > 0)
            filter.must.set('room_id', [...searchFilter.rooms]);
        if (searchFilter.notRooms.size > 0)
            filter.mustNot.set('room_id', [...searchFilter.notRooms]);

        // must satisfy sender
        if (searchFilter.senders.size > 0)
            filter.must.set('sender', [...searchFilter.senders]);
        if (searchFilter.notSenders.size > 0)
            filter.mustNot.set('sender', [...searchFilter.notSenders]);

        // must satisfy type
        if (searchFilter.types.size > 0)
            filter.must.set('type', [...searchFilter.types]);
        if (searchFilter.notTypes.size > 0)
            filter.mustNot.set('type', [...searchFilter.notTypes]);

        const r: BleveRequest = {
            from,
            keys,
            filter,
            sortBy,
            searchTerm,
            size: pageSize,
        };

        const resp: BleveResponse = await b.search(r);
        return {
            rows: resp.rows,
            lookup: await this.resolve(resp.rows, context),
            total: resp.total,
        };
    }
}

enum SearchOrder {
    Rank = 'rank',
    Recent = 'recent',
}

async function setup() {
    let creds = {
        userId: global.localStorage.getItem('userId'),
        deviceId: global.localStorage.getItem('deviceId'),
        accessToken: global.localStorage.getItem('accessToken'),
    };

    if (!creds.userId || !creds.deviceId || !creds.accessToken) {
        const loginClient = createClient({
            baseUrl: 'https://matrix.org',
        });

        try {
            const res = await loginClient.login('m.login.password', {
                user: '@webdevguru:matrix.org',
                password: '***REMOVED***',
                initial_device_display_name: 'Matrix Search Daemon',
            });

            console.log('Logged in as ' + res.user_id);
            global.localStorage.setItem('userId', res.user_id);
            global.localStorage.setItem('deviceId', res.device_id);
            global.localStorage.setItem('accessToken', res.access_token);

            creds = {
                userId: res.user_id,
                deviceId: res.device_id,
                accessToken: res.access_token,
            };
        } catch (err) {
            console.log('An error occured logging in!');
            console.log(err);
            process.exit(1);
        }
    }

    const cli = createClient({
        baseUrl: 'https://matrix.org',
        idBaseUrl: '',
        ...creds,
        useAuthorizationHeader: true,
        // sessionStore: new LevelStore(),
        // store: new IndexedDBStore({
        //     indexedDB: indexedDB,
        //     dbName: 'matrix-search-sync',
        //     localStorage: global.localStorage,
        // }),
        store: new MatrixInMemoryStore({
            localStorage: global.localStorage,
        }),
        sessionStore: new WebStorageSessionStore(global.localStorage),
    });

    cli.on('event', (event: MatrixEvent) => {
        if (event.isEncrypted()) return;
        return q.push(event);
    });
    cli.on('Event.decrypted', (event: MatrixEvent) => {
        if (event.isDecryptionFailure()) {
            console.warn(event);
            return;
        }
        return q.push(event);
    });

    try {
        await cli.initCrypto();
    } catch (e) {
        console.log(e);
    }
    cli.startClient();
    // process.exit(1);

    const app = express();
    app.use(bodyParser.json());
    app.use(cors({
        'allowedHeaders': ['access_token', 'Content-Type'],
        'exposedHeaders': ['access_token'],
        'origin': '*',
        'methods': 'POST',
        'preflightContinue': false
    }));

    app.post('/search', async (req: Request, res: Response) => {
        if (!req.body) {
            res.sendStatus(400);
            return;
        }

        let nextBatch: Batch | null = null;
        if (req.query['next_batch']) {
            try {
                nextBatch = JSON.parse(global.atob(req.query['next_batch']));
                console.info("Found next batch of", nextBatch);
            } catch (e) {
                console.error("Failed to parse next_batch argument", e);
            }
        }

        // verify that user is allowed to access this thing
        try {
            const castBody: MatrixSearchRequest = req.body;
            const roomCat = castBody.search_categories.room_events;

            let keys = ['content.body', 'content.name', 'content.topic']; // default vaue for roomCat.key
            if (roomCat.keys && roomCat.keys.length) keys = roomCat.keys;

            const includeState = Boolean(roomCat['include_state']);
            const eventContext = roomCat['event_context'];

            let groupByRoomId = false;
            let groupBySender = false;
            if (roomCat.groupings && roomCat.groupings.group_by) {
                roomCat.groupings.group_by.forEach(grouping => {
                    switch (grouping.key) {
                        case 'room_id':
                            groupByRoomId = true;
                            break;
                        case 'sender':
                            groupBySender = true;
                            break;
                    }
                });
            }

            let highlights: Array<string> = [];

            const searchFilter = new Filter(roomCat.filter || {}); // default to empty object to assume defaults

            const joinedRooms = cli.getRooms();
            const roomIds = joinedRooms.map((room: Room) => room.roomId);

            if (roomIds.length < 1) {
                res.json({
                    search_categories: {
                        room_events: {
                            highlights: [],
                            results: [],
                            count: 0,
                        },
                    },
                });
                return;
            }

            // SKIP for now
            // let roomIdsSet = searchFilter.filterRooms(roomIds);

            // if (b.isGrouping("room_id")) {
            //     roomIDsSet.Intersect(common.NewStringSet([]string{*b.GroupKey}))
            // }

            // TODO do we need this
            //rankMap := map[string]float64{}
            //allowedEvents := []*Result{}
            // TODO these need changing
            const roomGroups = new Map<string, GroupValue>();
            const senderGroups = new Map<string, GroupValue>();

            let globalNextBatch: string|null = null;
            let count: number = 0;

            let allowedEvents: Array<string> = [];
            const eventMap = new Map<string, Result>();

            const rooms = new Set<string>();

            const search = new Search(cli);
            const searchTerm = roomCat['search_term'];

            let result: Result;

            // TODO extend local event map using sqlite/leveldb
            switch (roomCat['order_by']) {
                case 'rank':
                case '':
                    // get messages from Bleve by rank // resolve them locally
                    result = await search.query(keys, searchFilter, SearchOrder.Rank, searchTerm, 0, eventContext);
                    break;

                case 'recent':
                    const from = nextBatch !== null ? nextBatch.from() : 0;
                    result = await search.query(keys, searchFilter, SearchOrder.Recent, searchTerm, from, eventContext);
                    // TODO get next back here
                    break;

                default:
                    res.sendStatus(501);
                    return;
            }

            if (allowedEvents.length < 1) {
                res.json({
                    search_categories: {
                        room_events: {
                            highlights: [],
                            results: [],
                            count: 0,
                        },
                    },
                });
                return;
            }

            // const highlightsSuperset = new Set<string>();
            // resp.rows.forEach((row: BleveResponseRow) => {
            //     row.highlights.forEach((highlight: string) => {
            //         highlightsSuperset.add(highlight);
            //     });
            // });

            allowedEvents.forEach((evId: string) => {
                const res = eventMap[evId];
                const ev = res.event;

                if (groupByRoomId) {
                    let v = roomGroups.get(ev.getRoomId());
                    if (!v) v = new GroupValue();
                    v.add(ev.getId(), res.order);
                    roomGroups.set(ev.getRoomId(), v);
                }
                if (groupBySender) {
                    let v = senderGroups.get(ev.getSender());
                    if (!v) v = new GroupValue();
                    v.add(ev.getId(), res.order);
                    senderGroups.set(ev.getSender(), v);
                }

                rooms.add(ev.getRoomId());
            });

            // TODO highlights calculation must remain on bleve side

            const roomStateMap = new Map<string, Array<MatrixEvent>>();
            if (includeState) {
                // TODO fetch state from server using API
                rooms.forEach((roomId: string) => {
                    const room = cli.getRoom(roomId);
                    if (room) {
                        roomStateMap.set(roomId, room.currentState.reduce((acc, map: Map<string, MatrixEvent>) => {
                            map.forEach((ev: MatrixEvent) => {
                                acc.push(ev);
                            });
                            return acc;
                        }, []));
                    }
                });
            }

            const results: Array<MatrixEvent> = allowedEvents.map((eventId: string) => eventMap[eventId].event);

            const resp = {
                search_categories: {
                    room_events: {
                        highlights: highlights,
                        nextBatch: globalNextBatch,
                        state: roomStateMap,
                        results,
                        count,
                    },
                },
            };

            if (groupByRoomId || groupBySender)
                resp.search_categories.room_events['groups'] = new Map<string, Map<string, GroupValue>>();

            if (groupByRoomId) resp.search_categories.room_events['groups']['room_id'] = roomGroups;
            if (groupBySender) resp.search_categories.room_events['groups']['sender'] = senderGroups;

            res.json(resp);

        } catch (e) {
            console.log("Catastrophe", e);
        }

        console.log(req.body);
        res.sendStatus(200);
    });

    const port = 8000;
    app.listen(port, () => {
        console.log('We are live on ' + port);
    });
}

class Filter {
    rooms: Set<string>;
    notRooms: Set<string>;
    senders: Set<string>;
    notSenders: Set<string>;
    types: Set<string>;
    notTypes: Set<string>;
    limit: number;
    containsURL: boolean | undefined;

    constructor(o: object) {
        this.rooms = new Set<string>(o['rooms']);
        this.notRooms = new Set<string>(o['not_rooms']);
        this.senders = new Set<string>(o['senders']);
        this.notSenders = new Set<string>(o['not_senders']);
        this.types = new Set<string>(o['types']);
        this.notTypes = new Set<string>(o['not_types']);

        this.limit = typeof o['limit'] === "number" ? o['limit'] : 10;
        this.containsURL = o['contains_url'];
    }
}

interface RequestEventContext {
    before_limit?: number;
    after_limit?: number;
    include_profile: boolean;
}

enum RequestGroupKey {
    roomId = "room_id",
    sender = "sender",
}

interface RequestGroup {
    key: RequestGroupKey;
}

interface RequestGroups {
    group_by?: Array<RequestGroup>;
}

enum RequestKey {
    body = "content.body",
    name = "content.name",
    topic = "content.topic",
}

interface MatrixSearchRequestBody {
    search_term: string;
    keys?: Array<RequestKey>;
    filter?: object; // this gets upconverted to an instance of Filter
    order_by?: string;
    event_context?: RequestEventContext;
    includeState?: boolean;
    groupings?: RequestGroups;
}

interface MatrixSearchRequest {
    search_categories: {
        room_events: MatrixSearchRequestBody;
    }
}