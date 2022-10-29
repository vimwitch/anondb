/* eslint-disable @typescript-eslint/no-unused-vars */
import AsyncLock from 'async-lock'
import {
  DB,
  Schema,
  FindManyOptions,
  FindOneOptions,
  WhereClause,
  UpdateOptions,
  UpsertOptions,
  DeleteManyOptions,
  TransactionDB
} from '../types'
import { validateDocuments, matchDocument } from '../helpers/memory'
import { loadIncluded } from '../helpers/shared'
import { execAndCallback } from '../helpers/callbacks'

export class MemoryConnector extends DB {
  schema: Schema = {}
  lock = new AsyncLock({ maxPending: 100000 })

  db = {
    __uniques__: {}
  }

  constructor(schema: Schema) {
    super()
    this.schema = schema
    for (const key of Object.keys(schema)) {
      this.db[key] = []
      for (const row of this.uniqueRows(key)) {
        this.db.__uniques__[this.uniqueRowKey(key, row.name)] = {}
      }
    }
  }

  uniqueRowKey(collection: string, row: string) {
    return `unique-${collection}-${row}`
  }

  // check if a row is unique or a primary key
  uniqueRows(_collection: string) {
    const collection = this.schema[_collection]
    if (!collection) {
      throw new Error(`Invalid collection: "${_collection}"`)
    }
    const rows = [] as any[]
    for (const row of collection.rows) {
      if (row.unique || [collection.primaryKey].flat().indexOf(row.name) !== -1)
        rows.push(row)
    }
    return rows
  }

  async create(_collection: string, doc: any) {
    const collection = this.schema[_collection]
    if (!collection) {
      throw new Error(`Invalid collection: "${_collection}"`)
    }
    const docs = validateDocuments(collection, doc)
    const newUniques = {}
    // now we've finalized the documents, compare uniqueness within the set
    for (const row of this.uniqueRows(_collection)) {
      newUniques[this.uniqueRowKey(_collection, row.name)] = {}
    }
    // make a copy to operate on
    for (const d of docs) {
      for (const row of this.uniqueRows(_collection)) {
        if (
          newUniques[this.uniqueRowKey(_collection, row.name)][d[row.name]] ||
          this.db.__uniques__[this.uniqueRowKey(_collection, row.name)][d[row.name]]
        ) {
          throw new Error(`Uniqueness constraint violation for row "${row.name}"`)
        }
        newUniques[this.uniqueRowKey(_collection, row.name)][d[row.name]] = true
      }
    }
    // all checks pass, start mutating
    for (const d of docs) {
      this.db[_collection].push(d)
    }
    for (const key of Object.keys(newUniques)) {
      this.db.__uniques__[key] = { ...this.db.__uniques__[key], ...newUniques[key]}
    }
    if (docs.length === 1) {
      return docs[0]
    } else {
      return docs
    }
  }

  async findMany(_collection: string, options: FindManyOptions) {
    const collection = this.schema[_collection]
    if (!collection) {
      throw new Error(`Invalid collection: "${_collection}"`)
    }
    const matches = [] as any[]
    for (const doc of this.db[_collection]) {
      if (matchDocument(options.where, doc)) {
        // make sure not to mutate stuff outside of this
        matches.push({ ...doc })
      }
    }
    const sortKeys = Object.keys(options.orderBy || {})
    if (sortKeys.length > 0) {
      // do some ordering
      const sortKey = sortKeys[0]
      matches.sort((a, b) => {
        if (a[sortKey] > b[sortKey]) {
          return (options.orderBy || {})[sortKey] === 'asc' ? 1 : -1
        } else if (a[sortKey] < b[sortKey]) {
          return (options.orderBy || {})[sortKey] === 'asc' ? -1 : 1
        }
        return 0
      })
    }
    await loadIncluded(_collection, {
      models: matches,
      include: options.include,
      findMany: this.findMany.bind(this),
      table: collection
    })
    return matches
  }

  async findOne(collection: string, options: FindOneOptions) {
    const docs = await this.findMany(collection, options)
    if (docs.length > 0) {
      return docs[0]
    }
    return null
  }

  async count(collection: string, where: WhereClause) {
    const docs = await this.findMany(collection, { where })
    return docs.length
  }

  async update(_collection: string, options: UpdateOptions) {
    const collection = this.schema[_collection]
    if (!collection) {
      throw new Error(`Invalid collection: "${_collection}"`)
    }
    let updatedCount = 0
    const newDocs = [] as any[]

    // deep copy for the operation
    const newUniques = {}
    for (const row of this.uniqueRows(_collection)) {
      newUniques[this.uniqueRowKey(_collection, row.name)] = {
        ...this.db.__uniques__[this.uniqueRowKey(_collection, row.name)]
      }
    }

    for (const doc of this.db[_collection]) {
      if (matchDocument(options.where, doc)) {
        updatedCount++
        const newDoc = {
          ...doc,
          ...options.update,
        }
        // first undo the uniques in the old doc
        for (const row of this.uniqueRows(_collection)) {
          delete newUniques[this.uniqueRowKey(_collection, row.name)][doc[row.name]]
        }
        // then add the new uniques from the new document
        // check when adding the new uniques
        for (const row of this.uniqueRows(_collection)) {
          if (newUniques[this.uniqueRowKey(_collection, row.name)][doc[row.name]]) {
            // we have a double unique
            throw new Error('Unique constraint violation')
          }
          newUniques[this.uniqueRowKey(_collection, row.name)][doc[row.name]] = true
        }
        newDocs.push(newDoc)
      } else {
        newDocs.push(doc)
      }
    }
    this.db[_collection] = newDocs
    this.db.__uniques__ = newUniques
    return updatedCount
  }

  async upsert(collection: string, options: UpsertOptions) {
    const updatedCount = await this.update(collection, options)
    if (updatedCount > 0) {
      return Object.keys(options.update).length === 0 ? 0 : updatedCount
    }
    const created = await this.create(collection, options.create)
    return Array.isArray(created) ? created.length : 1
  }

  async delete(_collection: string, options: DeleteManyOptions) {
    const collection = this.schema[_collection]
    if (!collection) {
      throw new Error(`Invalid collection: "${_collection}"`)
    }
    const newUniques = {}
    for (const row of this.uniqueRows(_collection)) {
      newUniques[this.uniqueRowKey(_collection, row.name)] = {
        ...this.db.__uniques__[this.uniqueRowKey(_collection, row.name)]
      }
    }
    const newDocs = [] as any[]
    for (const doc of this.db[_collection]) {
      if (!matchDocument(options.where, doc)) {
        newDocs.push(doc)
      } else {
        for (const row of this.uniqueRows(_collection)) {
          delete newUniques[this.uniqueRowKey(_collection, row.name)][doc[row.name]]
        }
      }
    }
    const deletedCount = this.db[_collection].length - newDocs.length
    this.db[_collection] = newDocs
    for (const row of this.uniqueRows(_collection)) {
      this.db.__uniques__[this.uniqueRowKey(_collection, row.name)] = newUniques
    }
    return deletedCount
  }

  async transaction(operation: (db: TransactionDB) => void, onComplete?: () => void) {
    const onCommitCallbacks = [] as any[]
    const onErrorCallbacks = [] as any[]
    const onCompleteCallbacks = [] as any[]
    if (onComplete) onCompleteCallbacks.push(onComplete)

    let start: Function | undefined
    let promise = new Promise(rs => {
      start = rs
    })
    // deep copy the database for doing operations on
    const tempDB = {
      __uniques__: { ...this.db.__uniques__ },
      __mark__: 'test'
    }
    for (const key of Object.keys(this.db)) {
      if (key === '__uniques__') continue
      tempDB[key] = []
      for (const doc of this.db[key]) {
        tempDB[key].push({ ...doc })
      }
    }
    const txThis = {
      schema: this.schema,
      db: tempDB
    } as any
    txThis.delete = this.delete.bind(txThis)
    txThis.create = this.create.bind(txThis)
    txThis.update = this.update.bind(txThis)
    txThis.upsert = this.upsert.bind(txThis)
    txThis.findOne = this.findOne.bind(txThis)
    txThis.findMany = this.findMany.bind(txThis)
    txThis.uniqueRows = this.uniqueRows.bind(txThis)
    txThis.uniqueRowKey = this.uniqueRowKey.bind(txThis)
    const db = {
      delete: (collection: string, options: DeleteManyOptions) => {
        promise = promise.then(() => txThis.delete(collection, options))
      },
      create: (collection: string, docs: any) => {
        promise = promise.then(() => txThis.create(collection, docs))
      },
      update: (collection: string, options: UpdateOptions) => {
        promise = promise.then(() => txThis.update(collection, options))
      },
      upsert: (collection: string, options: UpsertOptions) => {
        promise = promise.then(() => txThis.upsert(collection, options))
      },
      onCommit: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onCommit callback supplied')
        onCommitCallbacks.push(cb)
      },
      onError: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onError callback supplied')
        onErrorCallbacks.push(cb)
      },
      onComplete: (cb: Function) => {
        if (typeof cb !== 'function')
          throw new Error('Non-function onComplete callback supplied')
        onCompleteCallbacks.push(cb)
      },
    } as TransactionDB
    await execAndCallback(
      async function(this: any) {
        await Promise.resolve(operation(db))
        ;(start as Function)()
        await promise
        this.db = tempDB
      }.bind(this),
      {
        onError: onErrorCallbacks,
        onSuccess: onCommitCallbacks,
        onComplete: onCompleteCallbacks,
      }
    )
  }

  async close() {
    // no-op, it's just a variable
  }

  async closeAndWipe() {
    for (const key of Object.keys(this.db)) {
      this.db[key] = []
    }
  }
}