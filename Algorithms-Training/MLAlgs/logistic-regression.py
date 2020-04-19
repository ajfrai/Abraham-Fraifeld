#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sat Apr 18 09:38:47 2020

@author: fraifeld-mba
"""

"""
This is a vectorized implementation of logistic regression.
Meant to refresh the memory.
Learned about logistic regression in detail in Andrew Ng's Machine Learning Course
On Coursera
"""

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

from sklearn.model_selection import train_test_split



def h(X,theta):
    """"
    X: The rows of observations
    theta: The parameters
    
    This is the application of the parameters to the rows. 
    Each row in the output is the raw hypothesis of what y is for that row.
    """
    return np.matmul(X,np.transpose(theta))

def J(theta,X,y,regularize=False,l=0):
    """
    The cost function for logistic regression
    
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    
    
    
    For each observation,
        error[observation index] when true y is 1:
            -log(prediction) (0 when prediction = 1)
        error[observation index] when true y is 0:
             -log(1-prediction) (0 when prediction = 0)
             
    To avoid dividing by zero, we add 1e-7 to the logged terms
    
    
    
            
    """
    
    prediction = g(h(X,theta)) 
    if not regularize:
        return sum(y*np.log(prediction+ 1e-7) + (1-y)*np.log(1-prediction+ 1e-7))/-len(X)
    else:
         return sum(y*np.log(prediction+ 1e-7) + (1-y)*np.log(1-prediction+ 1e-7))/-len(X) + ((l/2*len(X)) * sum(np.square(theta)))
    
     

def g(z):
    """
    Applies the sigmoid function to the hypothesis
    This can be interpreted as the log likelihood the row is class 1
    """
    
    return 1/(1+np.exp(-z))

def g_prime(z):
    """
    The derivative of the sigmoid function with respect to z
    This formula is from http://cs229.stanford.edu/notes/cs229-notes1.pdf
    """
    return g(z)*(1-g(z))

def batch_gradiant_descent(theta,X,y,alpha,epsilon,regularize = False,l = 0):
    
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    alpha: the learning rate. This is the amount the derivative of transpose(theta)x gets multiplied by 
    when adjusting theta
    
    epsilon: the maximum acceptable error. we say the error has converged when it reaches epsilon or when error doesn't change
    between iterations
    
    regularize: boolean - determines if the logistic regression will be regularized
    lambda: the regularization parameter. Try various values to avoid overfitting
    
    The algorithm is as follows:
        
        while the error does no converge:
            simultaneously update each weight (theta) to be 
                its current value 
                + the learning rate (alpha) * the sum of the derivatives of the cost function with respect to X
                if regularizing, add lambda/|observations| * theta
                update error
                
    return theta: these are the optimal weights

    """

         
        
        
    theta = theta.astype('float')
    last_error = 0
    initial_error = J(theta,X,y,regularize,l)
    error_history = []
    error = initial_error
    error_history.append(error)
  #  i = 0
    while error != last_error and error > epsilon: # we will update error at each iteration
      
            
        changes = []
        for j in range(len(theta)):
            predictions = g(h(X,theta)) 
            change = theta[j] - alpha*sum((predictions-y)*X[:,j])
            if regularize and j != 0:
                change = change + (l/len(X)) * theta[j]
            changes.append(change)
        
        np.put(theta, list(range(len(theta))), changes)
        last_error = error
        error = J(theta,X,y,regularize,l)
        error_history.append(error)
      
        #i = i + 1
        #if i % 10000 == 0:
        ##        print(theta)
         #       print(error)
                  
                  
        if error > initial_error:
            print("Error is rising")
            break

    return (theta,error_history)
  
       
        
    


def stochastic_gradiant_descent(theta,X,y,alpha,epsilon,regularize=False,l=0):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    alpha: the learning rate. This is the amount the derivative of transpose(theta)x gets multiplied by 
    when adjusting theta
    
    epsilon: the maximum acceptable error. we say the error has converaged when it reaches epsilon
    
    regularize: boolean - determines if the logistic regression will be regularized
    lambda: the regularization parameter. Try various values to avoid overfitting
    
    This differs from batch gradiant descent because it updates theta after considering each observation
    May never converge
    
    
    The algorithm is as follows:
        
        while the error does no converge:
            simultaneously update each weight (theta) to be 
                its current value 
                + the learning rate (alpha) * the derivative of the cost function with respect to the observation
                update error
                
    return theta: these are close to the optimal weights
    
    
    """
    theta = theta.astype('float')
    last_error = 0
    initial_error = J(theta,X,y)
    error = initial_error
    iteration = 0
    error_history = []
        
    while error != last_error and error > epsilon:  # we will update error at each iteration
          
        
        ## Main Algorithm
        for i in range(len(X)):
      
            changes = []
            for j in range(len(theta)):
                change = theta[j] + alpha * ((y[i] - g(h(X[i],theta))) * X[i][j])
                if regularize and j != 0:
                    change = change + (l/len(X)) * theta[j]
                changes.append(change)
            np.put(theta,list(range(len(theta))),changes) # simultaneous update
            last_error = error
            error = J(theta,X,y)
            error_history.append(error)
            
        ## Debugging
            iteration = iteration + 1
            if iteration % 10000 == 0:
                print(theta)
                print(error)
        
        
        ## Break Conditions
            if error < epsilon:
                break
            
        if error > initial_error:
            break
    
    
    
    return (theta,error_history)

def fit(theta,X,y,alpha,epsilon,descent_method = 'stochastic',regularize=False,l=0):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    alpha: the learning rate. This is the amount the derivative of transpose(theta)x gets multiplied by 
    when adjusting theta
    
    epsilon: the maximum acceptable error. we say the error has converaged when it reaches epsilon
    descent_method = stochastic or batch
    
    regularize: boolean - determines if the logistic regression will be regularized
    lambda: the regularization parameter. Try various values to avoid overfitting
    
    This returns theta
    """
    if descent_method == 'stochastic':
        return stochastic_gradiant_descent(theta,X=X,y=y,alpha=alpha,epsilon=epsilon,regularize=regularize)
    else:
        return batch_gradiant_descent(theta,X=X,y=y,alpha=alpha,epsilon=epsilon,regularize=regularize)


def plot_learning_curve(X,y,descent_method = 'stochastic'):
    """
    X: The rows of observations
    y: The true values of the target variable
    descent_method = stochastic or batch
    
    This fits models with different learning rates and plots their error histories.
    It shows how the error changes over gradient descent iterations.
    
    We want an alpha that results in an error that declines rapidly and never increases
    
    """
    initial_theta = np.array([0 for i in range(X.shape[1])])
    
    error_hist_dict = {}
    alphas = [.001,.01,.003,.1,.3]
    for alpha in alphas:
        print(alpha)
        theta,error_hist_dict[alpha] = fit(initial_theta,X,y,alpha,.1,descent_method)
        print("Done training ...")
    
    for alpha in alphas:
        plt.plot(error_hist_dict[alpha][0:1000])
    plt.title("Error over iterations for various alphas")
    plt.xlabel("Epoch")
    plt.ylabel("Error")
    plt.show()
        
    
    
 
    

def calculate_accuracy(theta,X,y):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    We say prediction(x) = 1 if the sigmoid of the application of theta to x > .5
    
    returns the accuracy of the model, which is 
        correctly assessed rows / total rows
    """
    predictions = g(h(X,theta)) > .5
    return sum(np.equal(y,predictions)/len(y))

def calculate_precision(theta,X,y):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    We say prediction(x) = 1 if the sigmoid of the application of theta to x > .5
    
    returns the precision of the model, which is 
        true positivies/ true positives + false positives
    """
    predictions = g(h(X,theta)) > .5
    positive_predictions = [i for i,x in enumerate(predictions) if x == 1]
    tp = sum(y[positive_predictions] == 1)
    fp = sum(y[positive_predictions] == 0)
    
    return tp/(tp+fp)

def calculate_recall(theta,X,y):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    We say prediction(x) = 1 if the sigmoid of the application of theta to x > .5
    
    returns the recall of the model, which is 
        true positivies/ true positives + false negatives
    """
    
    predictions = g(h(X,theta)) > .5
    positive_predictions = [i for i,x in enumerate(predictions) if x == 1]
    negative_predictions = list(set(range(len(X))) - set(positive_predictions))
    tp = sum(y[positive_predictions] == 1)
    fn = sum(y[negative_predictions] == 1)
    
    return tp/(tp+fn)


def calculate_f1(theta,X,y):
    """
    X: The rows of observations
    theta: The parameters
    y: The true values of the target variable
    We say prediction(x) = 1 if the sigmoid of the application of theta to x > .5
    
    returns the f1 of the model, which combines precision and recall: 
        2* precision * recall / precision + recall
    """
    
    precision = calculate_precision(theta,X,y)
    recall = calculate_recall(theta,X,y)
    
    return (2 * precision * recall) / (precision + recall)


def evaluate_fit(theta,X_test,y_test,alpha,epsilon,metrics=['accuracy','precision','recall','f1']):
    """
    theta: The parameters
    X_test: The rows of observations used to test the model
    y_test: The true values of the target variable
    We say prediction(x) = 1 if the sigmoid of the application of theta to x > .5
    alpha: the learning rate. This is the amount the derivative of transpose(theta)x gets multiplied by 
    when adjusting theta
    
    epsilon: the maximum acceptable error. we say the error has converaged when it reaches epsilon
    
    metrics: the list of metrics to be printed ('accuracy','precision','recall','f1')
    
    prints the fitted model's performance on each of these metrics
    """
    for m in metrics:
        if m == 'accuracy':
            print("Accuracy: " + str(calculate_accuracy(theta,X_test,y_test)))
        if m == 'precision':
            print("Precision: " + str(calculate_precision(theta,X_test,y_test)))
        if m == 'recall':
            print("Recall: " + str(calculate_recall(theta,X_test,y_test)))
        if m == 'f1':
            print("F1: " + str(calculate_f1(theta,X_test,y_test)))
    
    
    
    
    

def get_x_y(df):
    
    """
    df - train.csv dataframe from the titanic Kaggle dataset
    This is customized preprocessing.
    
    """
    X = df[["Sex","Age"]].reset_index(drop=True)
    X.Sex = (X["Sex"] == 'male').astype('int')
    y = df["Survived"].reset_index(drop=True).values
    
    
    X["0"] = [1 for i in range(len(X))]
    X = X[["0","Sex","Age"]].values
    


    ## Normalize features
    X[:,[1,2]] = (X[:,[1,2]] - np.min(X[:,[1,2]],axis=0))/(np.max(X[:,[1,2]],axis=0)-np.min(X[:,[1,2]],axis=0))


    return (X,y)


path = "train.csv"
df = pd.read_csv(path)
df = df.drop(columns = df.columns.drop(["Age","Sex","Survived"])).dropna().reset_index(drop=True)
train_df,test_df = train_test_split(df, test_size=.3)


X_train,y_train = get_x_y(train_df)
X_test,y_test = get_x_y(test_df)




theta = np.array([0 for i in range(X_train.shape[1])])
alpha = .01
epsilon = .2
theta,error_history = fit(theta,X_train,y_train,alpha,epsilon,'batch',regularize=True,l=10)           
evaluate_fit(theta,X_test,y_test,alpha,epsilon)

