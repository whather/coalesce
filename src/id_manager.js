var get = Ember.get, set = Ember.set, merge = Ember.merge;

var uuid = 1;

export default class IdManager {
  constructor() {
    this.idMaps = Ember.MapWithDefault.create({
      defaultValue: function(typeKey) {
        return Ember.Map.create();
      }
    });
  }

  /**
    Three possible cases:

    1. The model already has a clientId and an id.
       Make sure the clientId maps to the id.

    2. The model has no id or clientId. The model must be a new
       record. Generate a clientId and set on the model.

    3. The model has and id but no clientId. Generate a new clientId,
       update the mapping, and assign it to the model.
  */
  reifyClientId(model) {
    var id = get(model, 'id'),
        clientId = get(model, 'clientId'),
        typeKey = get(model, 'typeKey'),
        idMap = this.idMaps.get(typeKey);

    if(id) {
      id = id + '';
    }

    if(id && clientId) {
      var existingClientId = idMap.get(id);
      Ember.assert("clientId has changed for " + model.toString(), !existingClientId || existingClientId === clientId);
      if(!existingClientId) {
        idMap.set(id, clientId);
      }
    } else if(!clientId) {
      if(id) {
        clientId = idMap.get(id);
      }
      if(!clientId) {
        clientId = this._generateClientId(typeKey);
      }
      set(model, 'clientId', clientId);
      idMap.set(id, clientId);
    } // else NO-OP, nothing to do if they already have a clientId and no id
    return clientId;
  }

  getClientId(typeKey, id) {
    var idMap = this.idMaps.get(typeKey);
    return idMap.get(id + '');
  }

  _generateClientId(typeKey) {
    return typeKey + (uuid++);
  }

}

// necessary to play with ember's container
IdManager.create = function() { return new IdManager() };