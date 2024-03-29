/* eslint-disable jest/require-top-level-describe, jest/no-export */
import assert from 'assert'
import { DB } from '../../src'

export default function(this: { db: DB }) {
  test('should execute transaction', async () => {
    const table = 'TableThree'
    const transactionPromise = this.db.transaction(db => {
      db.create(table, [
        {
          id: 'test0',
        },
        {
          id: 'test1',
        },
      ])
      db.update(table, {
        where: { id: 'test0' },
        update: { optionalField: 'test' },
      })
      db.upsert(table, {
        where: { id: 'test2' },
        create: { id: 'test2', optionalField: 'exists' },
        update: {},
      })
      db.upsert(table, {
        where: { id: 'test1' },
        create: { id: 'test1', optionalField: 'exists' },
        update: { optionalField: 'exists' },
      })
      db.upsert(table, {
        where: { id: 'test5' },
        create: { id: 'test5', optionalField: 'exists' },
        update: { optionalField: 'exists' },
      })
      db.delete(table, {
        where: { id: 'test5' },
      })
    })
    const createPromise = this.db
      .create(table, { id: 'test2' })
      .then(() => {
        // this promise should throw with a duplicate key violation
        assert(false)
      })
      .catch(() => assert(true))
    // Wait for database operations to complete, then see which promise rejected
    await Promise.all([transactionPromise, createPromise])
    const rows = await this.db.findMany(table, {
      where: {},
      orderBy: { id: 'asc' },
    })
    assert.equal(rows.length, 3)
    assert.equal(rows[0].optionalField, 'test')
    assert.equal(rows[1].optionalField, 'exists')
    assert.equal(rows[2].optionalField, 'exists')
  })

  test('should execute transaction (undefined/null handling)', async () => {
    const table = 'TableThree'
    await this.db.transaction(db => {
      db.create(table, [
        {
          id: 'test0',
          optionalField: 'test'
        },
        {
          id: 'test1',
        },
      ])
      db.update(table, {
        where: { optionalField: null },
        update: { optionalField: 'exists' },
      })
    })
    {
      const rows = await this.db.findMany(table, {
        where: {
          optionalField: 'exists',
        },
      })
      assert.equal(rows.length, 1)
    }
    await this.db.transaction(db => {
      db.update(table, {
        where: { optionalField: undefined },
        update: { optionalField: 'exists' },
      })
    })
    {
      const rows = await this.db.findMany(table, {
        where: {
          optionalField: 'exists',
        },
      })
      assert.equal(rows.length, 2)
    }
    await this.db.transaction(db => {
      db.delete(table, {
        where: { optionalField: undefined },
      })
    })
    {
      const rows = await this.db.findMany(table, {
        where: {},
      })
      assert.equal(rows.length, 0)
    }
    await this.db.transaction(db => {
      db.create(table, [
        {
          id: 'test0',
          optionalField: 'test'
        },
        {
          id: 'test1',
        },
      ])
      db.delete(table, {
        where: { optionalField: null },
      })
    })
    {
      const rows = await this.db.findMany(table, {
        where: {},
      })
      assert.equal(rows.length, 1)
    }
  })

  test('should not execute write during transaction', async () => {
    const table = 'TableThree'
    let rs
    const waitPromise = new Promise((_rs) => rs = _rs)
    const txPromise = this.db.transaction(async db => {
      db.create(table, [
        {
          id: 'test0',
        },
      ])
      await waitPromise
    })
    const createPromise = this.db.create(table, { id: 'test1' })
    await Promise.race([
      new Promise(r => setTimeout(r, 2000)),
      createPromise
    ])
    {
      const docs = await this.db.findMany(table, { where: {} })
      assert.equal(docs.length, 0)
    }
    rs()
    await Promise.all([
      createPromise,
      txPromise
    ])
    {
      const docs = await this.db.findMany(table, { where: {} })
      assert.equal(docs.length, 2)
    }
  })

  test('should rollback transaction', async () => {
    const table = 'TableThree'
    try {
      await this.db.transaction(db => {
        db.create(table, {
          id: 'test0',
        })
        db.upsert(table, {
          where: { id: 'test1' },
          create: { id: 'test1', optionalField: 'exists' },
          update: { optionalField: 'exists' },
        })
        // now run an operation that SHOULD fail
        db.create(table, {
          id: 'test0',
        })
      })
      assert(false)
    } catch (err) {
      assert(true)
    }
    // No documents should exist
    const count = await this.db.count(table, {})
    assert.equal(count, 0)
  })

  test('should execute transactions callbacks on success', async () => {
    const table = 'TableThree'
    let committed = false
    let completed = false
    let errored = false
    const transactionPromise = this.db.transaction(db => {
      db.create(table, {
        id: 'test0',
      })
      db.onCommit(() => {
        committed = true
      })
      db.onComplete(() => {
        completed = true
      })
      db.onError(() => {
        errored = true
      })
    })
    assert(!committed)
    assert(!completed)
    assert(!errored)
    await transactionPromise
    assert(committed)
    assert(completed)
    assert(!errored)
  })

  test('should execute transactions callbacks on error', async () => {
    const table = 'TableThree'
    let committed = false
    let completed = false
    let errored = false
    const transactionPromise = this.db.transaction(db => {
      db.create(table, {
        id: null,
      })
      db.onCommit(() => {
        committed = true
      })
      db.onComplete(() => {
        completed = true
      })
      db.onError(() => {
        errored = true
      })
    })
    assert(!committed)
    assert(!completed)
    assert(!errored)
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await transactionPromise.catch(() => {})
    assert(!committed)
    assert(completed)
    assert(errored)
  })

  test('should throw operation error before executing', async () => {
    const table = 'TableThree'
    let committed = false
    let completed = false
    let errored = false
    const transactionPromise = this.db.transaction(async db => {
      db.create(table, {
        id: 'test',
      })
      db.onCommit(() => {
        committed = true
      })
      db.onComplete(() => {
        completed = true
      })
      db.onError(() => {
        errored = true
      })
      await new Promise(r => setTimeout(r, 100))
      throw new Error('test error')
    })
    assert(!committed)
    assert(!completed)
    assert(!errored)
    try {
      await transactionPromise
    } catch (err) {
      assert.equal(err.toString(), 'Error: anondb error: Error: test error')
    }
    assert(!committed)
    assert(completed)
    assert(errored)
  })

  test('should execute onComplete callback on error', async () => {
    const table = 'TableThree'
    let completed = false
    const transactionPromise = this.db.transaction(
      async db => {
        db.create(table, {
          id: 'test',
        })
        await new Promise(r => setTimeout(r, 100))
        throw new Error('test error')
      },
      () => {
        completed = true
      },
    )
    try {
      await transactionPromise
    } catch (err) {
      assert.equal(err.toString(), 'Error: anondb error: Error: test error')
    }
    assert(completed)
  })

  test('should execute onComplete callback', async () => {
    const table = 'TableThree'
    let completed = false
    const transactionPromise = this.db.transaction(
      async db => {
        db.create(table, {
          id: null,
        })
        await new Promise(r => setTimeout(r, 100))
      },
      () => {
        completed = true
      },
    )
    assert(!completed)
    try {
      await transactionPromise
    } catch (err) {
      // eslint-disable-next-line no-empty
    }
    assert(completed)
  })

  test('should catch error in onCommit callback', async () => {
    const table = 'TableThree'
    try {
      await this.db.transaction(
        async db => {
          db.onCommit(async () => {
            throw new Error('IGNORE - onCommit test error - IGNORE')
          })
          db.create(table, {
            id: 'test',
          })
          await new Promise(r => setTimeout(r, 100))
        }
      )
      assert(false)
    } catch (err) {
      // eslint-disable-next-line no-empty
    }
  })

  test('should catch error in error onError callback', async () => {
    try {
      await this.db.transaction(
        async db => {
          db.onError(async () => {
            throw new Error('IGNORE - onError test error - IGNORE')
          })
          await new Promise(r => setTimeout(r, 100))
          throw new Error('test error')
        }
      )
      assert(false)
    } catch (err) {
      // eslint-disable-next-line no-empty
    }
  })

  test('should fail to register non-function callbacks', async () => {
    const table = 'TableThree'
    const transactionPromise = this.db.transaction(db => {
      db.create(table, {
        id: 'test0',
      })
      try {
        db.onCommit({} as any)
        assert(false)
      } catch (err) {
        assert.equal(
          err.toString(),
          'Error: Non-function onCommit callback supplied',
        )
      }
      try {
        db.onError({} as any)
        assert(false)
      } catch (err) {
        assert.equal(
          err.toString(),
          'Error: Non-function onError callback supplied',
        )
      }
      try {
        db.onComplete({} as any)
        assert(false)
      } catch (err) {
        assert.equal(
          err.toString(),
          'Error: Non-function onComplete callback supplied',
        )
      }
    })
    await transactionPromise
  })

  test('should not error on empty create', async () => {
    const table = 'TableThree'
    await this.db.transaction(db => {
      db.create(table, [])
    })
  })

  test('should not error on empty update', async () => {
    const table = 'TableThree'
    await this.db.transaction(db => {
      db.create(table, {
        id: 'test0',
      })
      db.update(table, {
        where: {
          id: 'test0',
        },
        update: {}
      })
    })
  })

  test('should not error on empty upsert', async () => {
    const table = 'TableThree'
    await this.db.transaction(db => {
      db.create(table, {
        id: 'test0',
      })
      db.upsert(table, {
        where: {
          id: 'test0'
        },
        update: {},
        create: {
          id: 'test0',
        }
      })
    })
  })
}
