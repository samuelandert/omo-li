import {EventQuery} from "../o-circles-protocol/eventQuery";
import {Event} from "../o-circles-protocol/interfaces/event";
import {Observable, Subject, Subscription} from "rxjs";
import FileSystem from "webnative/fs/filesystem";
import {BN} from "ethereumjs-util";
import {Directory, DirectoryChangeType} from "./directories/directory";
import {CacheEvent, CacheEventGroup} from "./entities/cacheEvent";
import {Entity} from "./entities/entity";
import {tryGetDappState} from "../o-os/loader";
import {FissionAuthState} from "../../dapps/fissionauth/manifest";

export type CacheEventGroups = {
  source: string,
  days: {
    [day: string]: CacheEventGroup
  }
}

export class CounterEntity implements Entity
{
  name: string;
  value: number
}

export class CountersDirectory extends Directory<CounterEntity>
{
  async maintainIndexes(change: DirectoryChangeType, entity: CounterEntity, indexHint: string | undefined): Promise<void>
  {
  }
}

export class EventDirectory extends Directory<CacheEventGroup>
{
  async maintainIndexes(change: DirectoryChangeType, entity: CacheEventGroup, indexHint: string | undefined): Promise<void>
  {
  }
}

/**
 * This Directory implementation can be used to cache blockchain events.
 * It groups the events by day and keeps one file per day in the directory.
 *
 * Incoming events are buffered before they're written.
 * To write the buffered events to the fs, call flush().
 */
export class EventStore
  /*extends Directory<CacheEventGroup>*/
{
  // Assuming one new block per 5 seconds this should be worth a week of events:
  public static readonly pageSize = 17280 * 7;

  private readonly _eventSources: {
    [name: string]: {
      source: EventQuery<Event>,
      subscription: Subscription,
      directory: Directory<CacheEventGroup>
    }
  } = {};

  private _buffer: {
    firstBlockNo: number,
    lastBlockNo: number,
    events: CacheEvent[]
  } = {
    firstBlockNo: Number.MAX_SAFE_INTEGER,
    lastBlockNo: Number.MIN_SAFE_INTEGER,
    events: []
  };

  private _fs: FileSystem;
  private _pathParts: string[];

  readonly counters: CountersDirectory;

  constructor(fs: FileSystem, pathParts: string[])
  {
    this._fs = fs;
    this._pathParts = pathParts;

    this.counters = new CountersDirectory(this._fs, this._pathParts.concat(["_counters"]));
  }

  /**
   * Attaches a new event source to the directory.
   * All events that appear on this source will be buffered.
   * @param name
   * @param source
   * @param factory
   */
  async attachEventSource(
    name: string,
    source: EventQuery<Event>)
    : Promise<Observable<Event>>
  {
    const self = this;
    const subject = new Subject<Event>();
    const subscription = source.events.subscribe(
      event =>
      {
        this.onEvent(name, self, event);
        subject.next(event);
      });

    const eventDirectory = new EventDirectory(this._fs, this._pathParts.concat([name]));

    this._eventSources[name] = {
      source: source,
      subscription: subscription,
      directory: eventDirectory
    };

    source.execute();
    return subject;
  }

  /**
   * Unsubscribes from an event source.
   * @param name
   */
  detachEventSource(name: string)
  {
    const eventSource = this._eventSources[name];
    if (!name)
      throw new Error("There is no event source with the name " + name);

    eventSource.subscription.unsubscribe();
    delete this._eventSources[name];
  }

  // TODO: Hack
  isInitial:boolean = true;

  /**
   * Writes all entries in the buffer to the FS.
   * This method leaves the buffer intact, to clear it use clearBuffer()
   */
  async flush(): Promise<string>
  {
    if (this._buffer.firstBlockNo == Number.MAX_SAFE_INTEGER
      || this._buffer.lastBlockNo == Number.MIN_SAFE_INTEGER
      && !this.isInitial)
    {
      this.isInitial = true;
      console.log("No new events to flush");
      return;
    }

    const presentSources = this._buffer.events.reduce((p, c) =>
    {
      p[c.source] = c;
      return p;
    }, {});

    const startDay = Math.floor(this._buffer.firstBlockNo / EventStore.pageSize);
    const endDay = Math.floor(this._buffer.lastBlockNo / EventStore.pageSize);

    // Load all events in that range from the FS to the buffer
    await Promise.all(Object.keys(presentSources).map(async sourceName =>
      await this.loadEventsFromFsToBuffer(sourceName, startDay, endDay)));

    // Then group, sort and deduplicate all events
    let daysPerSource = await Promise.all(Object.keys(presentSources).map(async sourceName => this.bufferToDailyGroups(sourceName)));
    daysPerSource = daysPerSource.map(dps => this.orderAndDeduplicateDailyGroups(dps));

    // Finally write them back to the fs.
    for (let dps of daysPerSource)
    {
      const directory = this._eventSources[dps.source].directory;

      for (const dayIdx in dps.days)
      {
        console.log("Saving '" + dayIdx + "' of source '" + dps.source + "' to fission drive: ", {
          name: dayIdx,
          events: dps.days[dayIdx].events
        });

        await directory.addOrUpdate({
          name: dayIdx,
          events: dps.days[dayIdx].events
        }, false, "flush");
      }

      await directory.publish();
      console.log("published changes in '" + dps.source + "'.")

      // Maintain a counter per event source to keep track of the last blockNo
      const maxBlockNo = Object.keys(dps.days).map(dayIdx => dps.days[dayIdx].events).reduce((p, c) =>
      {
        const maxOfDay = Object.keys(c).reduce((p_, c_) => parseInt(c_) > p_ ? parseInt(c_) : p_, 0);
        return maxOfDay > p ? maxOfDay : p;
      }, 0);

      await this.counters.addOrUpdate(<CounterEntity>{
        value: maxBlockNo,
        name: dps.source
      }, false, "updateCounter");

      await this.counters.publish();
      console.log("published changes in '_counters'.")
    }

    return "";
  }

  clearBuffer()
  {
    this._buffer = {
      firstBlockNo: Number.MAX_SAFE_INTEGER,
      lastBlockNo: Number.MIN_SAFE_INTEGER,
      events: []
    };
  }

  /**
   * Loads stored events for the given time span and returns an array of CacheEvents.
   * @param source
   * @param fromDay
   * @param toDay
   */
  async loadEventsFromFs(source: string, fromDay: number, toDay?: number): Promise<CacheEvent[]>
  {
    console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay})`)

    const eventDir = this._fs.appPath(this._pathParts.concat([source]));
    console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> Looking if source dir '${eventDir}' exists ...`)

    const parentDir = this._fs.appPath(this._pathParts);
    console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> Checking if parent dir '${parentDir}' exists ....`)

    if (!(await this._fs.exists(parentDir)))
    {
      console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> The parent dir of '" + eventDir + "' doesn't exist.`)
    }
    else
    {
      console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> The parent dir of '${eventDir}' exists (${parentDir}).`)
    }

    const directory =
      (await this._fs.exists(eventDir))
        ? new EventDirectory(this._fs, this._pathParts.concat([source]))
        : this._eventSources[source]?.directory;

    if (!directory)
    {
      console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> No directory for source`)
      // The directory doesn't exist. Return an empty array.
      return [];
    }

    console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> Source directory exists`)

    if (toDay && fromDay && fromDay > toDay)
    {
      throw new Error(`The fromDay (${fromDay}) is larger than the toDay (${toDay})`);
    }
    if ((fromDay && fromDay < 0) || (toDay && toDay < 0))
    {
      throw new Error(`The fromDay (${fromDay}) or toDay (${toDay}) is smaller than zero`);
    }

    if (!toDay)
    {
      console.log(`EventStore.loadEventsFromFs(source:'${source}', fromDay: ${fromDay}, toDay: ${toDay}) -> No 'toDay'. Reading it from the counters ..`)
      const counterEntity = await this.counters.tryGetByName(source);
      toDay = Math.ceil(counterEntity?.value / EventStore.pageSize);
    }

    if (!toDay)
    {
      // There are no stored entities for this source
      return [];
    }

    let allEvents: CacheEvent[] = [];
    for (let i = fromDay; i <= toDay; i++)
    {
      // Every group corresponds to one day.
      const groupName = "page_" + i.toString();

      if (!(await directory.exists([groupName])))
      {
        continue;
      }

      const existingData = await directory.tryGetByName(groupName);
      for (const blockNo in existingData.events)
      {
        const blockEvents = existingData.events[blockNo];
        if (!blockEvents)
          continue;

        allEvents = allEvents.concat(blockEvents);
      }
    }

    return allEvents;
  }

  /**
   * Loads stored events from the filesystem to the in-memory buffer.
   * @param source
   * @param fromDay
   * @param toDay
   */
  private async loadEventsFromFsToBuffer(source: string, fromDay: number, toDay: number)
  {
    const storedEvents = await this.loadEventsFromFs(source, fromDay, toDay);
    storedEvents.forEach(existingEvent =>
    {
      if (existingEvent.blockNo < this._buffer.firstBlockNo)
      {
        this._buffer.firstBlockNo = Math.floor(existingEvent.blockNo / EventStore.pageSize) * EventStore.pageSize;
      }

      if (existingEvent.blockNo > this._buffer.lastBlockNo)
      {
        this._buffer.lastBlockNo = (Math.ceil(existingEvent.blockNo / EventStore.pageSize) * EventStore.pageSize) - 1;
      }

      this._buffer.events.push(existingEvent);
    });
  }

  /**
   * Writes incoming events to the in-memory buffer.
   * @param source
   * @param self
   * @param event
   * @protected
   */
  protected async onEvent(
    source: string,
    self: EventStore,
    event: Event)
  {
    // Events from event attached event sources always originate from contracts.
    // The value and recipient fields stay empty, they're only used for transactions.
    const entity: CacheEvent = {
      blockNo: event.blockNumber.toNumber(),
      source: source,
      data: JSON.stringify(event.returnValues),
      blockHash: event.blockHash,
      senderType: "contract",
      senderRef: event.address,
      eventType: event.event,
      valueInWei: undefined,
      recipientRef: undefined,
      recipientType: undefined,
      transactionHash: undefined
    };

    if (event.blockNumber.lt(new BN(this._buffer.firstBlockNo.toString())))
    {
      this._buffer.firstBlockNo = Math.floor(event.blockNumber.toNumber() / EventStore.pageSize) * EventStore.pageSize;
    }

    if (new BN(event.blockNumber).gt(new BN(this._buffer.lastBlockNo.toString())))
    {
      this._buffer.lastBlockNo = (Math.ceil(event.blockNumber.toNumber() / EventStore.pageSize) * EventStore.pageSize) - 1;
    }

    this._buffer.events.push(entity);
  }

  /**
   * A ts implementation of java's String.hashCode() method.
   * @param str
   */
  private hashString(str: string)
  {
    let hash = 0;
    if (str.length == 0)
    {
      return hash;
    }
    for (var i = 0; i < str.length; i++)
    {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Groups all events per source per day and sorts the list within that group by block no. ASC.
   */
  private bufferToDailyGroups(source: string): {
    source: string,
    days: {
      [day: string]: CacheEventGroup
    }
  }
  {
    const daysOfSource: CacheEventGroups = {
      source: source,
      days: {}
    };

    for (const event of this._buffer.events.filter(o => o.source == source))
    {
      const dayIdx = "page_" + Math.floor(event.blockNo / EventStore.pageSize).toString();

      // Get or create day group
      const day = daysOfSource.days[dayIdx]
        ? daysOfSource.days[dayIdx]
        : {
          name: dayIdx,
          events: {}
        };

      // Get the group for the blockNo on this day or create one
      const eventsOfDay = day.events[event.blockNo]
        ? day.events[event.blockNo]
        : [];

      // Add the event to the day->block group
      eventsOfDay.push(event);
      day.events[event.blockNo] = eventsOfDay;

      // Update the group
      daysOfSource.days[dayIdx] = day;
    }

    return daysOfSource;
  }

  private orderAndDeduplicateDailyGroups(days: CacheEventGroups): CacheEventGroups
  {
    for (const dayIdx in days.days)
    {
      for (const blockNo in days.days[dayIdx].events)
      {
        days.days[dayIdx].events[blockNo].sort(
          (a, b) => a.blockNo < b.blockNo ? -1 : a.blockNo > b.blockNo ? 1 : 0);

        const distinctEvents = days.days[dayIdx].events[blockNo].reduce((p, c) =>
        {
          p[this.hashString(JSON.stringify(c))] = c;
          return p;
        }, {});

        const distinctEventsArray = Object.keys(distinctEvents)
          .map(key => distinctEvents[key]);

        days.days[dayIdx].events[blockNo] = distinctEventsArray;
      }
    }

    return days;
  }

  async maintainIndexes(change: DirectoryChangeType, entity: CacheEventGroup, indexHint: string | undefined): Promise<void>
  {
  }
}
