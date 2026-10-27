export interface ExpiringStoreOptions { ttlMs?:number; maxEntries?:number; now?:()=>number }
/** In-memory entries bounded by age and by count, oldest evicted first. */
export class ExpiringStore<V> {
  private readonly entries=new Map<string,{value:V;expiresAt:number}>();
  private readonly ttlMs:number;private readonly maxEntries:number;private readonly now:()=>number;
  constructor({ttlMs=60*60*1000,maxEntries=100,now=Date.now}:ExpiringStoreOptions={}){this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.now=now;}
  get size():number{this.purge();return this.entries.size;}
  get(key:string):V|undefined{
    const entry=this.entries.get(key);if(!entry)return undefined;
    if(entry.expiresAt<=this.now()){this.entries.delete(key);return undefined;}
    return entry.value;
  }
  set(key:string,value:V):void{
    this.entries.delete(key);this.purge();
    while(this.entries.size>=this.maxEntries)this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key,{value,expiresAt:this.now()+this.ttlMs});
  }
  /** Insertion order matches expiry order: stop at the first live entry. */
  private purge():void{
    const now=this.now();
    for(const [key,entry] of this.entries){if(entry.expiresAt>now)break;this.entries.delete(key);}
  }
}
