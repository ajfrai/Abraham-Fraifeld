#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sat Apr 25 16:38:05 2020

@author: fraifeld-mba
"""

#----------
# DB SCAN 
#----------

"""

1. Implementation
2. Explanation
3. Motivation
4. Application and Visualization - Using World Bank Data

A clustering algorithm

Original Paper: https://www.aaai.org/Papers/KDD/1996/KDD96-037.pdf
Additional Resources:
    - https://towardsdatascience.com/dbscan-algorithm-complete-guide-and-application-with-python-scikit-learn-d690cbae4c5d

With fast region query implementation (using r* trees) and better individual function implementation (oops), DBSCAN can run in O(n*logn) since there are at most c*n region queries, and that is the function
that dominates runtime
"""

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
import matplotlib.pyplot as plt

data = pd.read_csv("2.12_Health_systems.csv")
data = data.drop(columns=["Completeness_of_death_reg_2008-16","Province_State","Country_Region"])
data = data.dropna().reset_index(drop=True)

class point:
    """
    A class to represent each point input into DBScan

    """
    def __init__(self,vec):
        """
        value - the input vector
        cluster_id - the id of the cluster the point has been assigned to (int). cluster_id = -1 if cluster is noise
        """
        self.value = vec
        self.cluster_id = None

class DBSCANNer:
    """
    A class that implements the DBSCAN algorithm
    
    Main methods:
        - init: constructor
        - DBScan: runs dbscan on the points and saves it to the output object
        - visualize: produces a plot of the clustered data
    """
    def __init__(self,data):
        """
        Constructor
        
        - points is list of vectorized data
        - 
        """
        self.points = []
        self.kdist_sorted_points = None
        self.noise = -1 # this is the cluster id of noise
        
        
        
        # define a vectorized version of the function above
        self.preprocess(data)
        

    def preprocess(self,data):
        """
        data = a dataframe containing information to be clustered
        
        converts the data into a vector and then applies PCA to reduce
        the dimensions to 2
        finally creates a kdist sorted version of the data for finding the best
        epsilon (more information in this in the kdist and plot_kdist_graph docs)
        """
        X = data._get_numeric_data().dropna().values
        ## Apply PCA because the paper recommends its methods on 2d data
        pca = PCA(n_components=2)
        X = pca.fit_transform(X)
        for i in range(len(X)):
            self.points.append(point(X[i]))
        self.kdist_sorted_points = self.get_kdist_sorted_points()
    
    
    def reset_ids(self):
        for i in range(len(self.points)):
            self.points[i].cluster_id = None
        
    def dist(self,p,q):
            """
            - p: a point object
            - q: a point object
            
            returns the euclidean distance between p and q
            """
            return np.sqrt(np.sum(np.square(q.value-p.value)))
        
     
        
    
    
        
    
    def epsilon_neighborhood(self,p,epsilon,indices_only=False):
        """
        - p: a vector of length n
        - epsilon: the max distance between two points st they are in the same
        neighborhood
        -indices_only: a boolean value. if true, only return the indices in points of the epsilon neighborhood
        
        returns the set of points in the neighborhood of p
        
        This is a "region query," which is implemented more efficiently using R* trees O(logn)
        """
        if indices_only:
            return [i for i,q in enumerate(self.points) if self.dist(p,q) <= epsilon]
        
        else:
            return [(i,q) for i,q in enumerate(self.points) if self.dist(p,q) <= epsilon]
    
        
    
    def directly_density_reachable(self,p,q,epsilon,min_pts=4):
        """
        - p: a vector of length n
        - q: a vector of length n
        - epsilon: the max distance between two points st they are in the same
        neighborhood
        - min_pts: the minimum amount of points required to 
        consider a point a core point
        
        returns a boolean - p is 'directly density reachable' from q.
        Intuitively, this would mean p is in a cluster where q is a core point
        """
        q_neighborhood = self.epsilon_neighborhood(p,epsilon)
        if p not in q_neighborhood:
            return False
        else:
            return len(q_neighborhood) >= min_pts
    
    def density_reachable(self,p,q,epsilon,min_pts=4):
        """
        - p: a vector of length n
        - q: a vector of length n
        - epsilon: the max distance between two points st they are in the same
        neighborhood
        - min_pts: the minimum amount of points required to 
        consider a neighborhood a cluster
        
        Not implemented because not needed in the algorithm.
        The definition is 
        TRUE if there exists a chain of points x1...xn where 
            xn = p and x1 = q s.t. x_(i+1) is directly density reachable from 
            x_i. 
        FALSE otherwise
        
        If p is in a cluster C and q is density reachable from p, then
        by definition q is in C.
        """
        pass
    
    def density_connected(self,p,q,epsilon,min_pts=4):
        """
        - p: a vector of length n
        - q: a vector of length n
        - epsilon: the max distance between two points st they are in the same
        neighborhood
       - min_pts: the minimum amount of points required to 
        consider a point a core point
        
        Not implemented because not needed in the algorithm.
        The definition is 
        TRUE if there exists a point x s.t.
            p and q are both density reachable from x  
        FALSE otherwise
        
        All points in clusters are density connected by definition of cluster.
        
        Points not in any cluster are noise.
        """
        pass
    
    def distance_between_sets(self,s1,s2):
        """
        s1: a set of n points, which are d dimensional vectors
        s2: a set of n points, which are d dimensional vectors
        
        returns the minimum distance between any two points in the set
        """
        min_dist = float('inf')
        for p in s1:
            for q in s2:
                d = self.dist(p,q)
                if d < min_dist:
                    min_dist = d
        return min_dist
    
    
   
    def kdist(self,p,k=4):
        """
        p: a point for which to calculate kdist
        k: the size of the neigborhood used to determine a good value for epsilon
        
        let q1...k be the k closest points to p in ascending order
        kdist is the distance between p and k
        """
        sorted_points = sorted(self.points,key=lambda q:self.dist(p,q))
        return self.dist(p,sorted_points[k])
    
    def get_kdist_sorted_points(self,k=4):
        """
        k: the size of the neigborhood used to determine a good value for epsilon
        
        sorts points in k-dist order
        """
        k_dist_sorted_points = [(p,self.kdist(p,k)) for p in self.points]
        return sorted(k_dist_sorted_points,key = lambda x: x[1],reverse=True)
    
    def plot_kdist_graph(self,k = 4):
        """
        k: the size of the neigborhood used to determine a good value for epsilon
        
        plots points in sorted order by the distance between it and its 
        k closest neighbor
        
        This is part of the 'interactive process' described in the paper
        for determining a good value for epsilon. 
        
        We should select the value of y at the first valley
        """
        y = [self.kdist_sorted_points[i][1] for i in range(len(self.kdist_sorted_points))]
        X = list(range(len(self.kdist_sorted_points)))
        plt.plot(X,y)
        plt.title(str(k) + "-Dist Sorted Graph")
        plt.ylabel(str(k) +"-Dist")
        plt.xlabel("Point Rank")
        # Epsilon should be set to the distance at the valley point
        plt.show()
    
    def change_cluster_id(self,i,cluster_id):
        """
        i: the index of the point to assign to a new cluster
        cluster_id: the new cluster
        
        assigns a point to a new cluster
        """
        self.points[i].cluster_id = cluster_id
    
    def change_cluster_ids(self,indices,cluster_id):
        """
        incides: the indices of the point to assign to a new cluster
        cluster_id: the new cluster
        
        assigns a list of points to a new cluster
        """
        for i in indices:
                self.change_cluster_id(i,cluster_id)
                
    def next_id(self,clusterId=-1):
        """
        Returns the next cluster ID available
        """
        return clusterId + 1
    
    def expand_cluster(self,i,clusterId,epsilon,min_pts=4):
        """
        - i: the index of the point around which to consider expanding a cluster
        - clusterId: the current clusterID to assign to a new cluster
        - epsilon: the max distance between two points st they are in the same
        neighborhood
        - min_pts: the minimum amount of points required to 
        consider a point a core point
        
        Considers the expansion of a cluster around a potential core point.
        If the point is determined to be a core point, all of its eps neighborhood
        is assigned to its cluster. Then we consider each of those points 
        as potential core points, applying the process described above 
        until we have no more points to consider.
        """
        # get the indices of the points
        # in the epsilon neighborhood of points[i]
        seeds = self.epsilon_neighborhood(self.points[i],epsilon,indices_only=True)
        
        # check if the point is a core point
        # if len(epsilon_neighborhood(p)) >= min_pts, p is core
        if len(seeds) < min_pts:
            self.points[i].cluster_id = self.noise
            return False
        ### if it is core, assign the whole epsilon neighborhood to its cluster
        ### also assign each identified core point's epsilon neighborhood to 
        ### the cluster
        else:
            self.change_cluster_ids(seeds,clusterId) 
            seeds.remove(i)
            while len(seeds) > 0:
                current_point = self.points[seeds[0]]
                result = self.epsilon_neighborhood(current_point,epsilon,indices_only=True)
                if len(result) > 0:
                    for p_index in result:
                        if self.points[p_index].cluster_id in [None,-1]:
                            seeds.append(p_index)
                        self.change_cluster_id(p_index,clusterId)
                seeds.remove(seeds[0])
            return True
                
                
                        
                        
                    
                   
                     
           
        
        
            
    
    def DBSCAN(self,epsilon,min_pts=4):
        """
         - epsilon: the max distance between two points st they are in the same
        neighborhood
        - min_pts: the minimum amount of points required to 
        consider a point a core point. The paper recommends this be set to 4
        """
        self.reset_ids()
        clusterId = self.next_id(self.noise)
        for i in range(len(self.points)):
            point = self.points[i]
            if point.cluster_id == None:
                if self.expand_cluster(i,clusterId,epsilon,min_pts):
                    clusterId = self.next_id(clusterId)
                
            
                
    def plot_clusters(self,title = "DBSCAN Clusters"):
        """
        title: the title of the graphed clusters
        """
        X = []
        y = []
        colors= []
        noise_color = -1
        for p in self.points:
            X.append(p.value[0])
            y.append(p.value[1])
            if p.cluster_id == -1:
                colors.append(noise_color)
                noise_color = noise_color - 1
            else:
                colors.append(p.cluster_id+1)
        
        plt.scatter(X,y,c=colors)
        plt.ylabel("PCA 2")
        plt.xlabel("PCA 1")
        plt.title(title)
        plt.show()
        
