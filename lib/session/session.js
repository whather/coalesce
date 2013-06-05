require('../collections/model_array');
require('../collections/model_set');
require('./collection_manager');
require('./belongs_to_manager');
require('../model');
require('./merge_strategies');

var get = Ember.get, set = Ember.set;

Ep.Session = Ember.Object.extend({

  mergeStrategy: Ep.Theirs,

  _dirtyCheckingSuspended: false,

  init: function() {
    this._super.apply(this, arguments);
    this.models = Ep.ModelSet.create();
    this.orphans = Ember.Set.create();
    this.collectionManager = Ep.CollectionManager.create();
    this.belongsToManager = Ep.BelongsToManager.create();
    this.shadows = Ep.ModelSet.create();
    this.flushing = Ep.ModelSet.create();
  },

  create: function(type, hash) {
    if(typeof type === "string") {
      type = this.lookupType(type);
    }
    var model = type.create(hash);
    this.reifyClientId(model);
    // TODO: re-add logic below
    // relationships set during create and relationships
    // from detached instances must be registered
    // (normally done through observers)
    // if(model === merged) {
    //   model._registerRelationships();
    // }
    // TODO: we shouldn't merge here, we should update
    return this.merge(model);
  },

  adopt: function(model) {
    Ember.assert("Models instances cannot be moved between sessions. Use `add` or `update` instead.", !get(model, 'session') || get(model, 'session') === this);
    set(model, 'session', this);
    // It is possible that we are adding a model to the cache
    // which will replace a previously added lazy model.
    // This lazy model could still be used elsewhere, but we
    // keep track of it in `orphans` to clean up later.
    var existing = this.models.getModel(model);
    if(existing && existing !== model) {
      this.models.remove(existing);
      this.orphans.add(existing);
    }
    this.models.add(model);
    return model;
  },

  add: function(model) {
    var existing = getModel(model);
    if(existing) return existing;
    // TODO: how do we handle the initial load?
    // maybe special case merging when shadow record
    // doesn't exist to just overwrite
    var copy = existing.copy(this);
    this.adopt(copy);
    // trigger a load if not already loaded
    this.load(copy.constructor, copy.id);
    return copy;
  },

  update: function(model) {
    var existing = getModel(model);
    
    // TODO: update existing or add new
  },

  deleteModel: function(model) {
    this.modelWillBecomeDirty(model);
    set(model, 'isDeleted', true);
    this.collectionManager.modelWasDeleted(model);
    this.belongsToManager.modelWasDeleted(model);
  },

  load: function(type, id) {
    if(typeof type === "string") {
      type = this.lookupType(type);
    }
    // always coerce to string
    id = id.toString();

    var cached = this.getForId(type, id);
    if(cached && get(cached, 'isLoaded')) {
      return Ep.resolveModel(cached);
    } else {
      var session = this;
      // TODO: handle errors
      return Ep.resolveModel(this.adapter.load(type, id).then(function(model) {
        return session.merge(model);
      }, function(model) {
        throw session.merge(model);
      }), type, id, session);
    }
  },

  find: function(type, query) {
    if (Ember.typeOf(query) === 'object') {
      return this.findQuery(type, query);
    }
    return this.load(type, query);
  },

  findQuery: function(type, query) {
    if(typeof type === "string") {
      type = this.lookupType(type);
    }
    var session = this;
    // TODO: return a model array immediately here
    // and also take into account errors
    return this.adapter.findQuery(type, query).then(function(models) {
      var merged = Ep.ModelArray.create({content: models, session: session});
      return merged;
    });
  },

  refresh: function(model) {
    var session = this;
    return this.adapter.refresh(model).then(function(refreshedModel) {
      return session.merge(refreshedModel);
    }, function(refreshedModel) {
      throw session.merge(refreshedModel);
    });
  },

  flush: function() {
    if(this.flushing.length > 0) {
      throw new Ember.Error("Cannot flush if another flush is pending.");
    }

    var session = this,
        dirtyModels = get(this, 'dirtyModels'),
        shadows = get(this, 'shadows');
    
    // the adapter will return a list of models regardless
    // of whether the flush succeeded. it is in the merge
    // logic that the errors property of the model is consumed
    var promise = this.adapter.flush(this).then(function(models) {
      var res = models.map(function(model) {
        return session.merge(model);
      });
      return models;
    }, function(models) {
      var res = models.map(function(model) {
        return session.merge(model);
      });
      throw models;
    });

    // copy shadows into flushing
    shadows.forEach(function(model) {
      this.flushing.add(model);
    }, this);

    // update shadows with current models
    dirtyModels.forEach(function(model) {
      this.shadows.add(model.copy());
    }, this);

    return promise;
  },

  getModel: function(model) {
    return this.models.getModel(model);
  },

  getForId: function(type, id) {
    var clientId = this.adapter.getClientId(type, id);
    return this.models.getForClientId(clientId);
  },

  reifyClientId: function(model) {
    this.adapter.reifyClientId(model);
  },

  remoteCall: function(context, name) {
    var session = this;
    return this.adapter.remoteCall.apply(this.adapter, arguments).then(function(model) {
      return session.merge(model);
    }, function(model) {
      throw session.merge(model);
    });
  },

  modelWillBecomeDirty: function(model) {
    if(this._dirtyCheckingSuspended) {
      return;
    }
    var shadow = this.shadows.getModel(model);
    if(!shadow) {
      shadow = model.copy();
      this.shadows.addObject(shadow);
      // TODO: client revisions?
      // increment local revision
      // model.incrementProperty('clientRevision');
    }
  },

  destroy: function() {
    this._super();
    this.ophans.forEach(function(model) {
      model.destroy();
    });
    this.models.forEach(function(model) {
      model.destroy();
    });
    this.orphans.destroy();
    this.models.destroy();
    this.collectionManager.destroy();
    this.belongsToManager.destroy();
    this.shadows.destroy();
    this.flushing.destroy();
  },

  dirtyModels: Ember.computed(function() {
    return Ep.ModelSet.fromArray(this.shadows.map(function(model) {
      return this.models.getModel(model);
    }, this));
  }).volatile(),

  suspendDirtyChecking: function(callback, binding) {
    var self = this;

    // could be nested
    if(this._dirtyCheckingSuspended) {
      return callback.call(binding || self);
    }

    try {
      this._dirtyCheckingSuspended = true;
      return callback.call(binding || self);
    } finally {
      this._dirtyCheckingSuspended = false;
    }
  },

  newSession: function() {
    return Ep.ChildSession.create({
      container: this.container,
      parent: this
    });
  },

  lookupType: function(type) {
    return this.container.lookup('model:' + type);
  }

});