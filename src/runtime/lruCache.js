/**
 * src/runtime/lruCache.js
 *
 * Doubly-linked-list + Map LRU cache with O(1) get/set/evict.
 * Used as the hot actor registry in actorManager.js.
 */

class Node {
  constructor(key, value) {
    this.key   = key;
    this.value = value;
    this.prev  = null;
    this.next  = null;
  }
}

export class LRUCache {
  /**
   * @param {number} capacity  Maximum number of entries
   * @param {Function?} onEvict  Called with (key, value) when an entry is evicted
   */
  constructor(capacity, onEvict = null) {
    this.capacity = capacity;
    this.onEvict  = onEvict;
    this.map      = new Map();
    // Sentinel head/tail — simplifies edge cases
    this.head     = new Node(null, null);
    this.tail     = new Node(null, null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size() { return this.map.size; }

  get(key) {
    const node = this.map.get(key);
    if (!node) return undefined;
    this._moveToFront(node);
    return node.value;
  }

  has(key) { return this.map.has(key); }

  set(key, value) {
    let node = this.map.get(key);
    if (node) {
      node.value = value;
      this._moveToFront(node);
      return;
    }
    node = new Node(key, value);
    this.map.set(key, node);
    this._insertFront(node);

    if (this.map.size > this.capacity) {
      this._evictLRU();
    }
  }

  delete(key) {
    const node = this.map.get(key);
    if (!node) return false;
    this._removeNode(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Manually evict a specific key (e.g., idle spill).
   * Calls onEvict if provided.
   */
  evict(key) {
    const node = this.map.get(key);
    if (!node) return;
    this._removeNode(node);
    this.map.delete(key);
    if (this.onEvict) this.onEvict(node.key, node.value);
  }

  /**
   * Return all entries in LRU order (least-recently-used first).
   */
  entries() {
    const result = [];
    let cur = this.tail.prev;
    while (cur !== this.head) {
      result.push([cur.key, cur.value]);
      cur = cur.prev;
    }
    return result;
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _insertFront(node) {
    node.prev          = this.head;
    node.next          = this.head.next;
    this.head.next.prev = node;
    this.head.next     = node;
  }

  _removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _moveToFront(node) {
    this._removeNode(node);
    this._insertFront(node);
  }

  _evictLRU() {
    const lru = this.tail.prev;
    if (lru === this.head) return;
    this._removeNode(lru);
    this.map.delete(lru.key);
    if (this.onEvict) this.onEvict(lru.key, lru.value);
  }
}

export default LRUCache;
