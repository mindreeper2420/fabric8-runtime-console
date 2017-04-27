import {OnDestroy} from "@angular/core";
import {Observable} from "rxjs";
import {NamespacedResourceService} from "../service/namespaced.resource.service";
import {KubernetesResource} from "../model/kubernetesresource.model";
import {enrichServiceWithRoute, Service, Services} from "../model/service.model";
import {Route} from "../model/route.model";
import {RouteService} from "../service/route.service";
import {ServiceService} from "../service/service.service";
import {Watcher} from "../service/watcher";
import {DeploymentService} from "../service/deployment.service";
import {DeploymentConfigService} from "../service/deploymentconfig.service";
import {DeploymentViews, combineDeployments, createDeploymentViews} from "../view/deployment.view";
import {Deployment} from "../model/deployment.model";
import {DeploymentConfig} from "../model/deploymentconfig.model";
import {ReplicationControllerService} from "../service/replicationcontroller.service";
import {ReplicaSetViews, createReplicaSetViews} from "../view/replicaset.view";
import {combineReplicaSets, ReplicaSet} from "../model/replicaset.model";
import {ReplicationController} from "../model/replicationcontroller.model";
import {ReplicaSetService} from "../service/replicaset.service";

/**
 * A base class for components which watch kubernetes resources which contains a number of helper functions
 * for watching various kinds of resources in kubernetes together with logic to help close up watches after the
 * component has been used
 */
export class AbstractWatchComponent implements OnDestroy {
  private listObservableCache: Map<string, Observable<any[]>> = new Map<string, Observable<any[]>>();
  private watchCache: Map<string, Watcher> = new Map<string, Watcher>();

  ngOnDestroy(): void {
    for (let key in this.watchCache) {
      let watch = this.watchCache[key];
      if (watch) {
        watch.close();
      }
    }
  }

  protected listAndWatchServices(namespace: string, serviceService: ServiceService, routeService: RouteService): Observable<Services> {
    return Observable.combineLatest(
      this.listAndWatch(serviceService, namespace, Service),
      this.listAndWatch(routeService, namespace, Route),
      enrichServiceWithRoute,
    );
  }


  listAndWatchDeployments(namespace: string, deploymentService: DeploymentService, deploymentConfigService: DeploymentConfigService, serviceService: ServiceService, routeService: RouteService): Observable<DeploymentViews> {
    let deployments = Observable.combineLatest(
      this.listAndWatch(deploymentService, namespace, Deployment),
      this.listAndWatch(deploymentConfigService, namespace, DeploymentConfig),
      combineDeployments,
    );
    let runtimeDeployments = Observable.combineLatest(
      deployments,
      this.listAndWatchServices(namespace, serviceService, routeService),
      createDeploymentViews,
    );
    return runtimeDeployments;
  }

  listAndWatchReplicas(namespace: string, replicaSetService: ReplicaSetService, replicationControllerService: ReplicationControllerService, serviceService: ServiceService, routeService: RouteService): Observable<ReplicaSetViews> {
    let replicas = Observable.combineLatest(
      this.listAndWatch(replicaSetService, namespace, ReplicaSet),
      this.listAndWatch(replicationControllerService, namespace, ReplicationController),
      combineReplicaSets,
    );
    let replicaViews = Observable.combineLatest(
      replicas,
      this.listAndWatchServices(namespace, serviceService, routeService),
      createReplicaSetViews,
    );
    return replicaViews;
  }


  protected listAndWatch<T extends KubernetesResource, L extends Array<T>>(
    service: NamespacedResourceService<T, L>,
    namespace: string,
    type: { new (): T; }
  ) {
    return Observable.combineLatest(
      this.getOrCreateList(service, namespace, type),
      // We just emit an empty item if the watch fails
      this.getOrCreateWatch(service, namespace, type).dataStream.catch(() => Observable.of(null)),
      (list, msg) => this.combineListAndWatchEvent(list, msg, service, type, namespace),
    );
  }

  protected getOrCreateList<T extends KubernetesResource, L extends Array<T>>(
    service: NamespacedResourceService<T, L>,
      namespace: string,
      type: { new (): T; }
  ): Observable<L> {
    let key = namespace + "/" + type.name;
    let answer = this.listObservableCache[key];
    if (!answer) {
      answer = service.list(namespace);
      this.listObservableCache[key] = answer;
    }
    return answer;
  }

  protected getOrCreateWatch<T extends KubernetesResource, L extends Array<T>>(
    service: NamespacedResourceService<T, L>,
      namespace: string,
      type: { new (): T; }
  ): Watcher {
    let key = namespace + "/" + type.name;
    let answer = this.watchCache[key];
    if (!answer) {
      answer = service.watchNamepace(namespace);
      this.watchCache[key] = answer;
    }
    return answer;
  }

  /**
   * Lets combine the web socket events with the latest list
   */
  protected combineListAndWatchEvent<T extends KubernetesResource, L extends Array<T>>(array: L, msg: any, service: NamespacedResourceService<T, L>, objType: { new (): T; }, namespace: string): L {
    // lets process the added /updated / removed
    if (msg instanceof MessageEvent) {
      let me = msg as MessageEvent;
      let data = me.data;
      if (data) {
        var json = JSON.parse(data);
        if (json) {
          let type = json.type;
          let resource = json.object;
          if (type && resource) {
            switch (type) {
              case 'ADDED':
                return createNewArrayToForceRefresh(this.upsertItem(array, resource, service, objType));
              case 'MODIFIED':
                return this.upsertItem(array, resource, service, objType);
              case 'DELETED':
                return createNewArrayToForceRefresh(this.deleteItemFromArray(array, resource));
              default:
                console.log('Unknown WebSocket event type ' + type + ' for ' + resource + ' on ' + service.serviceUrl + '/' + namespace);
            }
          }
        }
      }
    }
    return array;
  }

  protected upsertItem<T extends KubernetesResource, L extends Array<T>>(array: L, resource: any, service: NamespacedResourceService<T, L>, type: { new (): T; }): L {
    let n = this.nameOfResource(resource);
    if (array && n) {
      for (let i = 0; i < array.length; i++) {
        let item = array[i];
        var name = item.name;
        if (name && name === n) {
          item.setResource(resource);
          return array;
        }
      }

      // now lets add the new item!
      let item = new type();
      item.setResource(resource);
      // lets add the Restangular crack
      item = service.restangularize(item);
      array.push(item);
    }
    return array;
  }


  protected deleteItemFromArray<T extends KubernetesResource, L extends Array<T>>(array: L, resource: any): L {
    let n = this.nameOfResource(resource);
    if (array && n) {
      for (var i = 0; i < array.length; i++) {
        let item = array[i];
        var name = item.name;
        if (name && name === n) {
          array.splice(i, 1);
        }
      }
    }
    return array;
  }

  nameOfResource(resource: any) {
    let obj = resource || {};
    let metadata = obj.metadata || {};
    return obj.name || metadata.name || '';
  }
}

/**
 * Lets create a new array instance to force an update event on insert or delete to lists
 */
function createNewArrayToForceRefresh<T extends KubernetesResource, L extends Array<T>>(array: L): L {
  return array.slice() as L;
}